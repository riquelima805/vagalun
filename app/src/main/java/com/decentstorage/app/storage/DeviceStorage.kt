package com.decentstorage.app.storage

import android.content.Context
import android.os.StatFs

object DeviceStorage {
    private const val SYSTEM_RESERVE_BYTES = 4L * 1024 * 1024 * 1024 // 4GB de folga

   
    fun freeBytes(context: Context): Long {
        val stat = StatFs(context.filesDir.path)
        return stat.availableBytes
    }

    
    fun maxOfferableBytes(context: Context): Long =
        (freeBytes(context) - SYSTEM_RESERVE_BYTES).coerceAtLeast(0L)
}
