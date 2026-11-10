package com.decentstorage.app.storage

import com.decentstorage.app.FilePrivacy
import com.decentstorage.app.UiFileEntry
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Guarda a lista "Meus arquivos" no disco. Antes ela só existia em memória: ao reiniciar o
 * celular a lista voltava vazia, mesmo com os fragmentos ainda gravados nos nós.
 */
object UiFileStore {
    private const val NAME = "ui-files.json"

    fun load(dir: File): List<UiFileEntry> {
        val main = File(dir, NAME)
        val bak = File(dir, "$NAME.bak")
        for (f in listOf(main, bak)) {
            if (!f.exists() || f.length() == 0L) continue
            try {
                val arr = JSONArray(f.readText())
                return (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    UiFileEntry(
                        fileId = o.getString("fileId"),
                        fileName = o.getString("fileName"),
                        sizeBytes = o.optLong("sizeBytes", 0L),
                        mimeType = o.optString("mimeType", "application/octet-stream"),
                        k = o.optInt("k", 1),
                        n = o.optInt("n", 1),
                        privacy = runCatching { FilePrivacy.valueOf(o.optString("privacy", "SHARED")) }.getOrDefault(FilePrivacy.SHARED),
                        retentionDays = o.optInt("retentionDays", 30),
                        uploadedAt = o.optLong("uploadedAt", System.currentTimeMillis())
                    )
                }
            } catch (e: Exception) {
                try { f.copyTo(File(dir, f.name + ".corrupt-" + System.currentTimeMillis()), overwrite = true) } catch (_: Exception) {}
            }
        }
        return emptyList()
    }

    @Synchronized
    fun save(dir: File, list: List<UiFileEntry>) {
        val arr = JSONArray()
        list.forEach { e ->
            arr.put(JSONObject()
                .put("fileId", e.fileId).put("fileName", e.fileName).put("sizeBytes", e.sizeBytes)
                .put("mimeType", e.mimeType).put("k", e.k).put("n", e.n)
                .put("privacy", e.privacy.name).put("retentionDays", e.retentionDays)
                .put("uploadedAt", e.uploadedAt))
        }
        val main = File(dir, NAME)
        val tmp = File(dir, "$NAME.tmp")
        FileOutputStream(tmp).use { o -> o.write(arr.toString().toByteArray(Charsets.UTF_8)); o.flush(); o.fd.sync() }
        if (main.exists() && main.length() > 0) {
            try { main.copyTo(File(dir, "$NAME.bak"), overwrite = true) } catch (_: Exception) {}
        }
        if (!tmp.renameTo(main)) { main.writeText(arr.toString()); tmp.delete() }
    }
}
