package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

public final class DrawingSyncService {
    private static final Gson GSON = new Gson();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder TOKEN_ENCODER =
        Base64.getUrlEncoder().withoutPadding();
    private static final String CODE_ALPHABET =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final Duration SESSION_TTL = Duration.ofHours(6);
    private static final int MAX_HISTORY = 20_000;
    private static final int MAX_MESSAGE_CHARS = 96 * 1024;
    private static final java.util.Set<String> ALLOWED_TYPES = java.util.Set.of(
        "canvas.stroke.begin",
        "canvas.stroke.points",
        "canvas.stroke.end",
        "canvas.undo",
        "canvas.redo",
        "canvas.clear"
    );

    public record Session(
        String drawingCode,
        String drawerToken,
        String createdAt,
        String expiresAt,
        long lastSequence
    ) {}

    public record PublicSession(
        String drawingCode,
        String expiresAt,
        long lastSequence
    ) {}

    private static final class State {
        private final String code;
        private final String drawerToken;
        private final Instant createdAt;
        private final Instant expiresAt;
        private final AtomicLong sequence = new AtomicLong();
        private final ArrayList<String> history = new ArrayList<>();

        private State(
            String code,
            String drawerToken,
            Instant createdAt,
            Instant expiresAt
        ) {
            this.code = code;
            this.drawerToken = drawerToken;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
        }
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    public Session createSession() {
        cleanupExpired();
        Instant now = Instant.now();
        String code = null;
        for (int attempt = 0; attempt < 64; attempt += 1) {
            String candidate = randomCode();
            if (!states.containsKey(candidate)) {
                code = candidate;
                break;
            }
        }
        if (code == null) {
            throw new IllegalStateException("failed to allocate drawing code");
        }

        String token = randomToken(32);
        var state = new State(code, token, now, now.plus(SESSION_TTL));
        if (states.putIfAbsent(code, state) != null) {
            return createSession();
        }
        return session(state);
    }

    public PublicSession findPublic(String code) {
        State state = activeState(code);
        return new PublicSession(
            state.code,
            state.expiresAt.toString(),
            state.sequence.get()
        );
    }

    public boolean isActive(String code) {
        try {
            activeState(code);
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    public boolean isAuthorizedDrawer(String code, String token) {
        if (token == null || token.isBlank()) return false;
        try {
            State state = activeState(code);
            return java.security.MessageDigest.isEqual(
                state.drawerToken.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                token.getBytes(java.nio.charset.StandardCharsets.UTF_8)
            );
        } catch (RuntimeException error) {
            return false;
        }
    }

    public String append(String code, String drawerToken, String rawJson) {
        if (!isAuthorizedDrawer(code, drawerToken)) {
            throw new SecurityException("drawing write authorization failed");
        }
        if (rawJson == null || rawJson.isBlank()) {
            throw new IllegalArgumentException("drawing event is required");
        }
        if (rawJson.length() > MAX_MESSAGE_CHARS) {
            throw new IllegalArgumentException("drawing event is too large");
        }

        JsonObject incoming;
        try {
            incoming = JsonParser.parseString(rawJson).getAsJsonObject();
        } catch (Exception error) {
            throw new IllegalArgumentException("drawing event must be a JSON object");
        }

        String type = incoming.has("type")
            ? incoming.get("type").getAsString()
            : "";
        if (!ALLOWED_TYPES.contains(type)) {
            throw new IllegalArgumentException("unsupported drawing event type");
        }

        JsonElement payload = incoming.has("payload")
            ? incoming.get("payload")
            : new JsonObject();

        State state = activeState(code);
        long sequence = state.sequence.incrementAndGet();

        var event = new JsonObject();
        event.addProperty("type", type);
        event.addProperty("drawingCode", state.code);
        event.addProperty("sequence", sequence);
        event.addProperty("createdAt", Instant.now().toString());
        event.add("payload", payload.deepCopy());

        String canonical = GSON.toJson(event);
        synchronized (state.history) {
            state.history.add(canonical);
            if (state.history.size() > MAX_HISTORY) {
                int removeCount = state.history.size() - MAX_HISTORY;
                state.history.subList(0, removeCount).clear();
            }
        }
        return canonical;
    }

    public List<String> history(String code) {
        State state = activeState(code);
        synchronized (state.history) {
            return List.copyOf(state.history);
        }
    }

    public int activeSessionCount() {
        cleanupExpired();
        return states.size();
    }

    private State activeState(String rawCode) {
        cleanupExpired();
        String code = normalizeCode(rawCode);
        State state = states.get(code);
        if (state == null || !state.expiresAt.isAfter(Instant.now())) {
            if (state != null) states.remove(code, state);
            throw new java.util.NoSuchElementException(
                "drawing sync session not found"
            );
        }
        return state;
    }

    private void cleanupExpired() {
        Instant now = Instant.now();
        states.entrySet().removeIf(
            entry -> !entry.getValue().expiresAt.isAfter(now)
        );
    }

    private static Session session(State state) {
        return new Session(
            state.code,
            state.drawerToken,
            state.createdAt.toString(),
            state.expiresAt.toString(),
            state.sequence.get()
        );
    }

    private static String normalizeCode(String value) {
        return value == null
            ? ""
            : value.trim().toUpperCase(Locale.ROOT);
    }

    private static String randomCode() {
        StringBuilder code = new StringBuilder(6);
        for (int index = 0; index < 6; index += 1) {
            code.append(
                CODE_ALPHABET.charAt(RANDOM.nextInt(CODE_ALPHABET.length()))
            );
        }
        return code.toString();
    }

    private static String randomToken(int byteCount) {
        byte[] bytes = new byte[byteCount];
        RANDOM.nextBytes(bytes);
        return TOKEN_ENCODER.encodeToString(bytes);
    }
}
