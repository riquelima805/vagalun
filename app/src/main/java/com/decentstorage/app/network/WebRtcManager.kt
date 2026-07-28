package com.decentstorage.app.network.webrtc

import android.content.Context
import com.decentstorage.app.network.ShardRequestHandler
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.util.concurrent.ConcurrentHashMap

class WebRtcManager(
    context: Context,
    private val signalingClient: SignalingClient,
    private val selfNodeId: String,
    private val requestHandler: ShardRequestHandler,
    private val onTransportReady: (peerNodeId: String, transport: WebRtcTransport) -> Unit,
    private val onTransportClosed: ((peerNodeId: String) -> Unit)? = null,
    iceServers: List<PeerConnection.IceServer> = defaultIceServers()
) {
    companion object {
        fun defaultIceServers(): List<PeerConnection.IceServer> = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer()
           
        )
    }

    private class Session {
        var pc: PeerConnection? = null
        var dataChannel: DataChannel? = null
        var transport: WebRtcTransport? = null
        val pendingRemoteCandidates = mutableListOf<IceCandidate>()
        var remoteDescSet = false
        var isInitiator = false
    }

    private val sessions = ConcurrentHashMap<String, Session>()
    private val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
        sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
    }

    private val eglBase: EglBase = EglBase.create()
    private val factory: PeerConnectionFactory

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
    }

    /** Chame depois de `signalingClient.connect()`. Roteia offer/answer/ice recebidos pra sessão certa. */
    fun handleSignal(fromNodeId: String, payload: JSONObject) {
        when (payload.optString("kind")) {
            "offer" -> onOfferReceived(fromNodeId, payload.getString("sdp"))
            "answer" -> onAnswerReceived(fromNodeId, payload.getString("sdp"))
            "ice" -> onIceReceived(fromNodeId, payload)
        }
    }

    /** Inicia conexão WAN com um peer já conhecido (ex: veio do BootstrapPeerList). Nós somos o ofertante. */
    fun connectToPeer(peerNodeId: String) {
        if (sessions.containsKey(peerNodeId)) return // já conectando/conectado
        val session = Session().also { it.isInitiator = true }
        sessions[peerNodeId] = session

        val pc = factory.createPeerConnection(rtcConfig, observerFor(peerNodeId, session)) ?: run {
            sessions.remove(peerNodeId); return
        }
        session.pc = pc

        val dcInit = DataChannel.Init().apply { ordered = true } // ordenado/confiável, igual TCP
        val dc = pc.createDataChannel("shard", dcInit)
        wireDataChannel(peerNodeId, session, dc)

        pc.createOffer(object : SdpObserver by noopSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(noopSdpObserver(), desc)
                signalingClient.sendSignal(peerNodeId, JSONObject().put("kind", "offer").put("sdp", desc.description))
            }
        }, MediaConstraints())
    }

    private fun onOfferReceived(fromNodeId: String, sdp: String) {
        val session = sessions.getOrPut(fromNodeId) { Session() }
        val pc = session.pc ?: factory.createPeerConnection(rtcConfig, observerFor(fromNodeId, session))
            ?.also { session.pc = it }
            ?: return

        pc.setRemoteDescription(object : SdpObserver by noopSdpObserver() {
            override fun onSetSuccess() {
                session.remoteDescSet = true
                flushPendingCandidates(pc, session)
                pc.createAnswer(object : SdpObserver by noopSdpObserver() {
                    override fun onCreateSuccess(desc: SessionDescription) {
                        pc.setLocalDescription(noopSdpObserver(), desc)
                        signalingClient.sendSignal(fromNodeId, JSONObject().put("kind", "answer").put("sdp", desc.description))
                    }
                }, MediaConstraints())
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun onAnswerReceived(fromNodeId: String, sdp: String) {
        val session = sessions[fromNodeId] ?: return
        val pc = session.pc ?: return
        pc.setRemoteDescription(object : SdpObserver by noopSdpObserver() {
            override fun onSetSuccess() {
                session.remoteDescSet = true
                flushPendingCandidates(pc, session)
            }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    private fun onIceReceived(fromNodeId: String, payload: JSONObject) {
        val session = sessions[fromNodeId] ?: return
        val candidate = IceCandidate(
            payload.optString("sdpMid"),
            payload.optInt("sdpMLineIndex"),
            payload.optString("candidate")
        )
        val pc = session.pc
        if (pc != null && session.remoteDescSet) {
            pc.addIceCandidate(candidate)
        } else {
           
            session.pendingRemoteCandidates.add(candidate)
        }
    }

    private fun flushPendingCandidates(pc: PeerConnection, session: Session) {
        session.pendingRemoteCandidates.forEach { pc.addIceCandidate(it) }
        session.pendingRemoteCandidates.clear()
    }

    private fun wireDataChannel(peerNodeId: String, session: Session, dc: DataChannel) {
        session.dataChannel = dc
        dc.registerObserver(object : DataChannel.Observer {
            override fun onStateChange() {
                when (dc.state()) {
                    DataChannel.State.OPEN -> {
                        if (session.transport == null) {
                            val transport = WebRtcTransport(peerNodeId, dc, requestHandler)
                            session.transport = transport
                            onTransportReady(peerNodeId, transport)
                        }
                    }
                    DataChannel.State.CLOSED -> {
                        sessions.remove(peerNodeId)
                        onTransportClosed?.invoke(peerNodeId)
                    }
                    else -> {}
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
               
            }
            override fun onBufferedAmountChange(previousAmount: Long) {}
        })
    }

 
    private fun observerFor(peerNodeId: String, session: Session): PeerConnection.Observer =
        object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                signalingClient.sendSignal(
                    peerNodeId,
                    JSONObject().put("kind", "ice")
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex)
                )
            }

            override fun onDataChannel(dc: DataChannel) {
                wireDataChannel(peerNodeId, session, dc)
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                if (state == PeerConnection.IceConnectionState.FAILED ||
                    state == PeerConnection.IceConnectionState.CLOSED
                ) {
                    sessions.remove(peerNodeId)
                    onTransportClosed?.invoke(peerNodeId)
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: org.webrtc.MediaStream) {}
            override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out org.webrtc.MediaStream>) {}
        }

    fun disconnect(peerNodeId: String) {
        sessions.remove(peerNodeId)?.let { session ->
            session.transport?.close()
            session.pc?.close()
        }
    }

    fun disconnectAll() {
        sessions.keys.toList().forEach { disconnect(it) }
        eglBase.release()
    }

   
    private fun noopSdpObserver(): SdpObserver = object : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String) {}
        override fun onSetFailure(error: String) {}
    }
}
