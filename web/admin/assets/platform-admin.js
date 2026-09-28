(() => {
  const $ = (id) => document.getElementById(id);
  let timer = 0;

  function text(value, fallback = "-") {
    return value == null || value === "" ? fallback : String(value);
  }

  function renderProviders(payload) {
    const providers = Array.isArray(payload?.providers)
      ? payload.providers
      : [];
    const soop = providers.find((provider) =>
      String(provider?.id || "").toUpperCase() === "SOOP"
    ) || {};

    $("soopProviderStatus").textContent = text(soop.status, "미설정");
    $("soopStreamerId").textContent = text(soop.streamerId, "미설정");
    $("soopBroadcastTitle").textContent = text(soop.title, "방송 정보 없음");
    $("soopDonationEvents").textContent =
      Number.isFinite(Number(soop.donationEvents))
        ? String(Number(soop.donationEvents))
        : "0";
  }

  function eventDescription(event) {
    const type = String(event?.type || "event");
    const provider = String(event?.provider || "-");

    if (type === "chat.message") {
      const who = text(event.nickname || event.userId, "익명");
      return {
        badge: provider + " · CHAT",
        title: who,
        detail: text(event.message, "")
      };
    }

    if (type === "donation") {
      const who = text(event.nickname || event.userId, "익명");
      return {
        badge: provider + " · DONATION",
        title: who,
        detail:
          text(event.amount, "0")
          + " "
          + text(event.unit, "")
      };
    }

    return {
      badge: provider + " · " + type.toUpperCase(),
      title: text(event.eventType, type),
      detail: ""
    };
  }

  function renderEvents(payload) {
    const list = $("platformEventList");
    const events = Array.isArray(payload?.events)
      ? payload.events.slice().reverse()
      : [];

    if (!events.length) {
      list.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "event-empty";
      empty.textContent = "아직 수신된 채팅/후원 이벤트가 없습니다.";
      list.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const event of events) {
      const view = eventDescription(event);
      const item = document.createElement("article");
      item.className = "event-item";

      const meta = document.createElement("span");
      meta.className = "event-badge";
      meta.textContent = view.badge;

      const body = document.createElement("div");
      body.className = "event-body";

      const title = document.createElement("strong");
      title.textContent = view.title;
      body.appendChild(title);

      if (view.detail) {
        const detail = document.createElement("p");
        detail.textContent = view.detail;
        body.appendChild(detail);
      }

      item.append(meta, body);
      fragment.appendChild(item);
    }
    list.replaceChildren(fragment);
  }

  async function refresh(silent = false) {
    try {
      const [providerResponse, eventResponse] = await Promise.all([
        fetch("/api/v1/providers", { cache: "no-store" }),
        fetch("/api/v1/events/recent?limit=8", { cache: "no-store" })
      ]);

      if (providerResponse.status === 401 || eventResponse.status === 401) {
        window.location.replace("/admin/");
        return;
      }
      if (!providerResponse.ok) {
        throw new Error("Provider HTTP " + providerResponse.status);
      }
      if (!eventResponse.ok) {
        throw new Error("Event HTTP " + eventResponse.status);
      }

      renderProviders(await providerResponse.json());
      renderEvents(await eventResponse.json());
    } catch (error) {
      if (!silent) {
        $("soopProviderStatus").textContent = "조회 실패";
        const list = $("platformEventList");
        list.textContent = "플랫폼 상태 조회 실패: " + error.message;
      }
    }
  }

  $("refreshPlatformState")?.addEventListener("click", () => refresh(false));
  refresh(false);
  timer = window.setInterval(() => refresh(true), 3000);
  window.addEventListener(
    "beforeunload",
    () => window.clearInterval(timer),
    { once: true }
  );
})();
