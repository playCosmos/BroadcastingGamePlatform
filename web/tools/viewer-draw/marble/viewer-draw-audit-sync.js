(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let currentAudit = null;
  let currentSavedAudit = null;

  function stable(value) {
    if (Array.isArray(value)) {
      return value.map(stable);
    }
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = stable(value[key]);
          return result;
        }, {});
    }
    return value;
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(
      JSON.stringify(stable(value))
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function qualification(detail) {
    const policy = detail.definition?.runPolicy || {};
    const winnerCount = Array.isArray(detail.state?.rankedEntries)
      ? detail.state.rankedEntries.length
      : 0;
    const minimum = Math.max(
      0,
      Math.trunc(Number(policy.qualificationMinWinners) || 0)
    );
    const maxNudges = Math.max(
      0,
      Math.trunc(Number(policy.qualificationMaxNudges) || 0)
    );
    const reasons = [];

    if (minimum > 0 && winnerCount < minimum) {
      reasons.push(
        "winner count " + winnerCount + " < required " + minimum
      );
    }
    if (maxNudges > 0 && detail.stuckNudges > maxNudges) {
      reasons.push(
        "nudge count " + detail.stuckNudges + " > allowed " + maxNudges
      );
    }

    return {
      status: reasons.length ? "NOT_QUALIFIED" : "QUALIFIED",
      reasons,
      qualificationMinWinners: minimum,
      qualificationMaxNudges: maxNudges
    };
  }

  async function buildAudit(detail) {
    const definitionHash = await sha256(detail.definition);
    const snapshotHash = await sha256(detail.entries);
    const ranked = Array.isArray(detail.state?.rankedEntries)
      ? detail.state.rankedEntries
      : [];
    return {
      schemaVersion: "viewer-draw-run-audit/v0",
      resultStatus: detail.state?.timedOut
        ? "TIMEOUT"
        : "COMPLETED",
      qualification: qualification(detail),
      map: {
        name: String(detail.definition?.name || "Untitled Map"),
        definitionHash
      },
      entries: {
        count: detail.entries.length,
        snapshotHash
      },
      engine: {
        id: String(detail.engineId || "UNKNOWN"),
        fixedTimestepSeconds: 1 / 120
      },
      run: {
        seed: Number(detail.seed) || 1,
        startedAt: detail.startedAt || null,
        completedAt: detail.completedAt || null,
        simulationSeconds: Number(detail.state?.time) || 0,
        stuckNudges: Math.max(0, Number(detail.stuckNudges) || 0)
      },
      result: {
        winners: ranked.map((entry, index) => ({
          rank: index + 1,
          entryId: entry?.entryId || null,
          displayName: entry?.displayName || ""
        })),
        finishOrder: detail.state?.finishOrder || [],
        eliminationOrder: detail.state?.eliminationOrder || [],
        dnf: detail.state?.dnfOrder || [],
        outputClaims: detail.state?.outputClaims || [],
        slotClaims: detail.state?.slotClaims || [],
        sensorClaims: detail.state?.sensorClaims || [],
        branchStates: detail.state?.branchStates || [],
        selectedOutputKey: detail.state?.selectedOutputKey || null
      }
    };
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
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || ("HTTP " + response.status));
    }
    return body;
  }

  function setStatus(message) {
    if ($("auditSyncStatus")) {
      $("auditSyncStatus").textContent = message;
    }
  }

  function overlayUrl(publicCode) {
    return new URL(
      "/tools/viewer-draw/?auditCode="
        + encodeURIComponent(publicCode),
      window.location.origin
    ).href;
  }

  function selectSavedAudit(saved) {
    currentSavedAudit = saved || null;
    const code = String(saved?.publicCode || "");
    const link = $("auditOverlayLink");
    const copy = $("copyAuditOverlay");
    if (link) {
      link.hidden = !code;
      link.href = code ? overlayUrl(code) : "#";
    }
    if (copy) copy.disabled = !code;
  }

  async function refreshHistory() {
    const select = $("auditHistory");
    if (!select) return;
    const body = await api("/api/v1/tools/viewer-draw/audits");
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "저장된 Audit 없음";
    select.appendChild(empty);

    for (const audit of body.audits || []) {
      const option = document.createElement("option");
      option.value = audit.auditId;
      option.dataset.publicCode = audit.publicCode || "";
      option.textContent =
        (audit.completedAt || audit.createdAt || "")
        + " · "
        + (audit.resultStatus || "")
        + " · "
        + (audit.publicCode || "");
      select.appendChild(option);
    }
  }

  function exportAudit() {
    if (!currentAudit) return;
    const blob = new Blob(
      [JSON.stringify(currentAudit, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "viewer-draw-marble-audit.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  window.addEventListener(
    "viewer-draw:run-completed",
    async (event) => {
      try {
        currentAudit = await buildAudit(event.detail || {});
        if ($("uploadAudit")) $("uploadAudit").disabled = false;
        if ($("exportAudit")) $("exportAudit").disabled = false;
        setStatus(
          "LOCAL AUDIT READY · "
            + currentAudit.qualification.status
        );
      } catch (error) {
        currentAudit = null;
        setStatus("AUDIT ERROR · " + error.message);
      }
    }
  );

  $("uploadAudit")?.addEventListener("click", async () => {
    if (!currentAudit) return;
    const button = $("uploadAudit");
    button.disabled = true;
    setStatus("AUDIT 저장 중...");
    try {
      const saved = await api(
        "/api/v1/tools/viewer-draw/audits",
        {
          method: "POST",
          body: JSON.stringify(currentAudit)
        }
      );
      selectSavedAudit(saved);
      setStatus("SAVED · " + saved.publicCode);
      await refreshHistory();
      if ($("auditHistory")) {
        $("auditHistory").value = saved.auditId || "";
      }
    } catch (error) {
      setStatus("SAVE ERROR · " + error.message);
    } finally {
      button.disabled = !currentAudit;
    }
  });

  $("exportAudit")?.addEventListener("click", exportAudit);
  $("refreshAuditHistory")?.addEventListener("click", () => {
    void refreshHistory().catch((error) => {
      setStatus("HISTORY ERROR · " + error.message);
    });
  });
  $("auditHistory")?.addEventListener("change", (event) => {
    const option = event.target.selectedOptions?.[0];
    const code = option?.dataset?.publicCode || "";
    if (!code) {
      selectSavedAudit(null);
      return;
    }
    selectSavedAudit({ publicCode: code });
  });
  $("copyAuditOverlay")?.addEventListener("click", async () => {
    const code = currentSavedAudit?.publicCode;
    if (!code) return;
    await navigator.clipboard.writeText(overlayUrl(code));
    setStatus("OBS URL 복사 완료");
  });

  if ($("auditHistory")) {
    void refreshHistory().catch((error) => {
      setStatus("HISTORY ERROR · " + error.message);
    });
  }

  window.ViewerDrawAuditSync = Object.freeze({
    enabled: true,
    currentAudit: () => currentAudit
  });
})();