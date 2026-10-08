package com.decentstorage.app.browser

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedDeque

// Log embutido no próprio app, pra não depender de logcat/adb pra ver o que
// o navegador está recebendo/mandando na hora (gossip bruto, peers, downloads).
// Guarda só as últimas MAX_LINES entradas (evita crescer sem limite se o app
// ficar aberto muito tempo) e expõe getAll()/clear() pra UI.
object DebugLog {
    private const val MAX_LINES = 400
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val lines = ConcurrentLinkedDeque<String>()

    @Synchronized
    fun add(msg: String) {
        val stamped = "[${fmt.format(Date())}] $msg"
        lines.addLast(stamped)
        while (lines.size > MAX_LINES) lines.pollFirst()
    }

    fun getAll(): String = lines.joinToString("\n\n")

    @Synchronized
    fun clear() = lines.clear()
}
