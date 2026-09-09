package com.decentstorage.app.storage

import android.content.Context
import android.os.StatFs


object DeviceStorage {
    const val SYSTEM_RESERVE_BYTES: Long = 4L * 1024 * 1024 * 1024 // 4GB de folga

   
    fun freeBytes(context: Context): Long {
        val stat = StatFs(context.filesDir.path)
        return stat.availableBytes
    }

   
    fun totalBytes(context: Context): Long {
        val stat = StatFs(context.filesDir.path)
        return stat.totalBytes
    }

    
    fun maxOfferableBytes(context: Context): Long =
        (freeBytes(context) - SYSTEM_RESERVE_BYTES).coerceAtLeast(0L)

    fun maxOfferableGb(context: Context): Int =
        (maxOfferableBytes(context) / (1024L * 1024 * 1024)).toInt().coerceAtLeast(1)
}
