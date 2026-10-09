package io.github.playcosmos.broadcastinggameplatform.operations;

import java.io.PrintStream;
import java.nio.file.Files;

public final class FileLogProbe {
    private FileLogProbe() {}

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory("platform-log-probe-");
        PrintStream originalOut = System.out;
        try {
            try (var log = FileLog.install(root, 1024)) {
                System.out.print("x".repeat(2500));
                System.out.flush();
                require(
                    Files.isRegularFile(log.path()),
                    "current rotated log file must exist"
                );
            }

            require(
                System.out == originalOut,
                "FileLog close must restore System.out"
            );

            try (var files = Files.list(root)) {
                var logs = files
                    .filter(Files::isRegularFile)
                    .filter(path ->
                        path.getFileName().toString().endsWith(".log")
                    )
                    .toList();
                require(
                    logs.size() >= 3,
                    "small log limit must rotate into multiple files"
                );
                for (var path : logs) {
                    require(
                        Files.size(path) <= 1024,
                        "rotated log file must respect size bound"
                    );
                }
            }

            System.out.println("File log probe passed.");
        } finally {
            System.setOut(originalOut);
            try (var paths = Files.walk(root)) {
                paths.sorted((left, right) -> right.compareTo(left))
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {
                        }
                    });
            }
        }
    }

    private static void require(
        boolean condition,
        String message
    ) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
