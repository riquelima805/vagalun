package com.decentstorage.app.storage

import android.content.Context
import android.os.StatFs

/**
 * Substitui o "makeup" do slider de cota (1..200 GB fixo, sem checar nada). Usa StatFs
 * pra saber quanto espaço LIVRE existe de verdade no armazenamento interno do app, e
 * nunca deixa o usuário oferecer mais do que isso, sempre guardando uma reserva de
 * sistema (padrão 4GB) pra não travar o Android por falta de espaço.
 */
object DeviceStorage {
    const val SYSTEM_RESERVE_BYTES: Long = 4L * 1024 * 1024 * 1024 // 4GB de folga

    /** Espaço realmente livre no armazenamento interno do app, agora (bytes). */
    fun freeBytes(context: Context): Long {
        val stat = StatFs(context.filesDir.path)
        return stat.availableBytes
    }

    /** Espaço total do particionamento onde o app grava (bytes) — só informativo na UI. */
    fun totalBytes(context: Context): Long {
        val stat = StatFs(context.filesDir.path)
        return stat.totalBytes
    }

    /** Máximo que o usuário pode oferecer pra rede agora, descontando a reserva de sistema. */
    fun maxOfferableBytes(context: Context): Long =
        (freeBytes(context) - SYSTEM_RESERVE_BYTES).coerceAtLeast(0L)

    fun maxOfferableGb(context: Context): Int =
        (maxOfferableBytes(context) / (1024L * 1024 * 1024)).toInt().coerceAtLeast(1)
}
