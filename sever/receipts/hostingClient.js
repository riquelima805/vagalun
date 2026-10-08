'use strict';

/** Cliente do endpoint interno do hosting (POST /internal/delivery-charge). */
function createHostingClient({ url = process.env.HOSTING_URL, token = process.env.HOSTING_INTERNAL_TOKEN, fetchImpl = fetch } = {}) {
  if (!url || !token) return null;
  return {
    /** @returns {Promise<{results:{domain:string, requestedUsd:number, chargedUsd:number, reason?:string}[]}>} */
    async charge(batchId, items) {
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/internal/delivery-charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ batchId, items }),
      });
      if (!res.ok) throw new Error(`hosting respondeu ${res.status}`);
      return res.json();
    },
  };
}
module.exports = { createHostingClient };
