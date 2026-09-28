package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.JsonParser;

public final class DrawingSyncProbe {
    private DrawingSyncProbe() {}

    public static void main(String[] args) {
        var service = new DrawingSyncService();
        var session = service.createSession();

        require(session.drawingCode().length() == 6, "drawing code must be six characters");
        require(session.drawerToken().length() >= 32, "drawer token must be opaque and long");
        require(service.isActive(session.drawingCode()), "drawing session must be active");
        require(
            service.isAuthorizedDrawer(
                session.drawingCode(),
                session.drawerToken()
            ),
            "drawer token must authorize writes"
        );
        require(
            !service.isAuthorizedDrawer(
                session.drawingCode(),
                "wrong-token"
            ),
            "wrong drawer token must be rejected"
        );

        String begin = service.append(
            session.drawingCode(),
            session.drawerToken(),
            """
            {
              "type":"canvas.stroke.begin",
              "payload":{
                "stroke":{
                  "strokeId":"s1",
                  "tool":"pen",
                  "color":"#111111",
                  "width":8,
                  "points":[{"x":0.1,"y":0.2}]
                }
              }
            }
            """
        );
        String points = service.append(
            session.drawingCode(),
            session.drawerToken(),
            """
            {
              "type":"canvas.stroke.points",
              "payload":{
                "strokeId":"s1",
                "points":[{"x":0.2,"y":0.3}]
              }
            }
            """
        );
        String end = service.append(
            session.drawingCode(),
            session.drawerToken(),
            """
            {
              "type":"canvas.stroke.end",
              "payload":{"strokeId":"s1"}
            }
            """
        );

        require(sequence(begin) == 1L, "first drawing sequence must be 1");
        require(sequence(points) == 2L, "drawing sequence must increase");
        require(sequence(end) == 3L, "drawing end sequence mismatch");
        require(service.history(session.drawingCode()).size() == 3, "history must retain drawing events");
        require(
            service.findPublic(session.drawingCode()).lastSequence() == 3L,
            "public session must expose latest sequence"
        );

        boolean denied = false;
        try {
            service.append(
                session.drawingCode(),
                "wrong-token",
                "{\"type\":\"canvas.clear\",\"payload\":{}}"
            );
        } catch (SecurityException expected) {
            denied = true;
        }
        require(denied, "unauthorized drawing write must fail");

        boolean unsupported = false;
        try {
            service.append(
                session.drawingCode(),
                session.drawerToken(),
                "{\"type\":\"canvas.inject\",\"payload\":{}}"
            );
        } catch (IllegalArgumentException expected) {
            unsupported = true;
        }
        require(unsupported, "unsupported drawing event type must fail");

        System.out.println("Drawing sync probe passed.");
    }

    private static long sequence(String json) {
        return JsonParser.parseString(json)
            .getAsJsonObject()
            .get("sequence")
            .getAsLong();
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
