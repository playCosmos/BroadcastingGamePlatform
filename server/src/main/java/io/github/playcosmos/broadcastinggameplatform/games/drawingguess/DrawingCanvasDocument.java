package io.github.playcosmos.broadcastinggameplatform.games.drawingguess;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;

/** Materialized canvas state, including the undo/redo stack. */
final class DrawingCanvasDocument {
    private final ArrayList<JsonObject> strokes = new ArrayList<>();
    private final ArrayList<JsonObject> redoStack = new ArrayList<>();

    static DrawingCanvasDocument restore(JsonObject payload) {
        var document = new DrawingCanvasDocument();
        for (JsonElement value : payload.getAsJsonArray("strokes")) {
            document.strokes.add(value.getAsJsonObject().deepCopy());
        }
        for (JsonElement value : payload.getAsJsonArray("redoStack")) {
            document.redoStack.add(value.getAsJsonObject().deepCopy());
        }
        return document;
    }

    JsonObject snapshot() {
        var result = new JsonObject();
        var visible = new JsonArray();
        for (JsonObject stroke : strokes) visible.add(stroke.deepCopy());
        result.add("strokes", visible);
        var redo = new JsonArray();
        for (JsonObject stroke : redoStack) redo.add(stroke.deepCopy());
        result.add("redoStack", redo);
        return result;
    }

    void apply(JsonObject event) {
        String type = event.get("type").getAsString();
        JsonObject payload = event.getAsJsonObject("payload");
        switch (type) {
            case "canvas.stroke.begin" -> {
                JsonObject stroke = payload.getAsJsonObject("stroke");
                String id = stroke.get("strokeId").getAsString();
                if (find(id) != null) return;
                strokes.add(stroke.deepCopy());
                redoStack.clear();
            }
            case "canvas.stroke.points" -> {
                String id = payload.get("strokeId").getAsString();
                JsonObject stroke = find(id);
                if (stroke == null) return;
                JsonArray points = stroke.getAsJsonArray("points");
                for (JsonElement point : payload.getAsJsonArray("points")) {
                    points.add(point.deepCopy());
                }
            }
            case "canvas.undo" -> {
                if (!strokes.isEmpty()) {
                    redoStack.add(strokes.remove(strokes.size() - 1));
                }
            }
            case "canvas.redo" -> {
                if (!redoStack.isEmpty()) {
                    strokes.add(redoStack.remove(redoStack.size() - 1));
                }
            }
            case "canvas.clear" -> {
                strokes.clear();
                redoStack.clear();
            }
            case "canvas.stroke.end" -> {
                // Ending a stroke does not change the materialized canvas.
            }
            default -> throw new IllegalArgumentException(
                "unsupported drawing event: " + type
            );
        }
    }

    private JsonObject find(String id) {
        for (JsonObject stroke : strokes) {
            if (id.equals(stroke.get("strokeId").getAsString())) return stroke;
        }
        return null;
    }
}
