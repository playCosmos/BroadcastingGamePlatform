(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let currentAudit = null;
  let currentOverlayUrl = "";

  function setStatus(message) {
    $("auditSyncStatus").textContent = message;
  }

  function setOverlayCode(code) {
    const normalized = String(code || "").trim().toUpperCase();
    if (!normalized) {
      currentOverlayUrl = "";
      $("auditOverlayLink").hidden = true;
      $("copyAuditOverlay").disabled = true;
      return;
    }
    currentOverlayUrl =
      location.origin
      + "/tools/viewer-draw/?auditCode="
      + encodeURIComponent(normalized);
    $("auditOverlayLink").href = currentOverlayUrl;
    $("auditOverlayLink").hidden = false;
    $("copyAuditOverlay").disabled = false;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });
    const payload = response.status === 204
      ? null
      : await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload?.error || ("HTTP " + response.status)
      );
    }
    return payload;
  }

  async function refreshHistory() {
    const select = $("auditHistory");
    select.disabled = true;
    try {
      const payload = await api(
        "/api/v1/tools/viewer-draw/audits"
      );
      const audits = Array.isArray(payload?.audits)
        ? payload.audits
        : [];
      select.replaceChildren();
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = audits.length
        ? "저장된 Audit 선택"
        : "저장된 Audit 없음";
      select.appendChild(empty);
      for (const audit of audits) {
        const option = document.createElement("option");
        option.value = audit.auditId;
        option.dataset.publicCode = audit.publicCode || "";
        option.textContent =
          (audit.qualificationStatus || "-")
          + " · "
          + (audit.resultStatus || "-")
          + " · "
          + (audit.mapName || "Marble")
          + " · "
          + (audit.publicCode || "");
        select.appendChild(option);
      }
      setStatus(
        audits.length
          ? "SERVER HISTORY " + audits.length
          : "SERVER HISTORY EMPTY"
      );
    } catch (error) {
      setStatus("SERVER HISTORY UNAVAILABLE · " + error.message);
    } finally {
      select.disabled = false;
    }
  }

  async function uploadCurrentAudit() {
    if (!currentAudit) return;
    $("uploadAudit").disabled = true;
    setStatus("UPLOADING AUDIT...");
    try {
      const saved = await api(
        "/api/v1/tools/viewer-draw/audits",
        {
          method: "POST",
          body: JSON.stringify(currentAudit)
        }
      );
      setOverlayCode(saved.publicCode);
      setStatus(
        "SAVED · "
        + saved.publicCode
        + " · "
        + saved.qualificationStatus
      );
      await refreshHistory();
      $("auditHistory").value = saved.auditId;
    } catch (error) {
      setStatus("UPLOAD FAILED · " + error.message);
    } finally {
      $("uploadAudit").disabled = !currentAudit;
    }
  }

  window.addEventListener(
    "viewer-draw-audit-ready",
    (event) => {
      currentAudit = structuredClone(event.detail);
      $("uploadAudit").disabled = false;
      setOverlayCode("");
      setStatus("LOCAL AUDIT READY");
    }
  );

  window.addEventListener(
    "viewer-draw-audit-cleared",
    () => {
      currentAudit = null;
      $("uploadAudit").disabled = true;
      setOverlayCode("");
      setStatus("LOCAL ONLY");
    }
  );

  $("uploadAudit").addEventListener(
    "click",
    uploadCurrentAudit
  );
  $("refreshAuditHistory").addEventListener(
    "click",
    refreshHistory
  );
  $("auditHistory").addEventListener("change", () => {
    const selected = $("auditHistory").selectedOptions[0];
    setOverlayCode(selected?.dataset?.publicCode || "");
  });
  $("copyAuditOverlay").addEventListener(
    "click",
    async () => {
      if (!currentOverlayUrl) return;
      try {
        await navigator.clipboard.writeText(currentOverlayUrl);
        setStatus("OBS URL COPIED");
      } catch {
        setStatus("OBS URL COPY FAILED");
      }
    }
  );

  void refreshHistory();
})();
