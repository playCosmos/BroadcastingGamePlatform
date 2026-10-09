package io.github.playcosmos.broadcastinggameplatform.operations;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.Locale;

public final class FileLog implements AutoCloseable {
    private static final DateTimeFormatter FILE_TIME =
        DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS");
    private static final int MAX_RETAINED_LOG_FILES = 30;
    private static final String LOG_PREFIX =
        "broadcasting-game-platform-";
    private static final String LEGACY_LOG_PREFIX =
        "roulette-bridge-";

    private final PrintStream originalOut;
    private final PrintStream originalErr;
    private final PrintStream file;
    private final PrintStream teeOut;
    private final PrintStream teeErr;
    private final Path path;

    private FileLog(PrintStream originalOut, PrintStream originalErr, PrintStream file, Path path) {
        this.originalOut = originalOut;
        this.originalErr = originalErr;
        this.file = file;
        this.path = path;
        this.teeOut = new TeePrintStream(originalOut, file);
        this.teeErr = new TeePrintStream(originalErr, file);
    }

    public static FileLog install(Path directory) throws IOException {
        Path root = directory.toAbsolutePath().normalize();
        Files.createDirectories(root);
        hideDirectoryOnWindows(root);
        String stamp = LocalDateTime.now().format(FILE_TIME);
        Path path = null;
        OutputStream stream = null;
        for (int attempt = 0; attempt < 1000; attempt += 1) {
            Path candidate = root.resolve(
                LOG_PREFIX
                    + stamp
                    + (attempt == 0 ? "" : "-" + attempt)
                    + ".log"
            );
            try {
                stream = Files.newOutputStream(
                    candidate,
                    StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE
                );
                path = candidate;
                break;
            } catch (FileAlreadyExistsException ignored) {
                // Extremely fast restarts may collide even at millisecond precision.
            }
        }
        if (stream == null || path == null) {
            throw new IOException("failed to allocate unique log file");
        }
        pruneOldLogs(root, path);
        var file = new PrintStream(stream, true, StandardCharsets.UTF_8);
        var log = new FileLog(System.out, System.err, file, path);
        System.setOut(log.teeOut);
        System.setErr(log.teeErr);
        System.out.println("[log] " + path);
        System.out.println("[encoding] console-out=" + log.originalOut.charset()
            + " console-err=" + log.originalErr.charset()
            + " file=UTF-8");
        return log;
    }

    private static void pruneOldLogs(
        Path root,
        Path current
    ) {
        try (var files = Files.list(root)) {
            var candidates = files
                .filter(Files::isRegularFile)
                .filter(FileLog::isManagedLog)
                .sorted(
                    Comparator.comparingLong(
                        FileLog::lastModifiedMillis
                    ).reversed()
                )
                .toList();

            for (
                int index = MAX_RETAINED_LOG_FILES;
                index < candidates.size();
                index += 1
            ) {
                Path candidate = candidates.get(index);
                if (candidate.equals(current)) continue;
                try {
                    Files.deleteIfExists(candidate);
                } catch (IOException ignored) {
                    // Logging must not fail because retention cleanup failed.
                }
            }
        } catch (IOException ignored) {
            // Logging must not fail because retention cleanup failed.
        }
    }

    private static boolean isManagedLog(Path path) {
        String name = path.getFileName().toString();
        return name.endsWith(".log")
            && (
                name.startsWith(LOG_PREFIX)
                || name.startsWith(LEGACY_LOG_PREFIX)
            );
    }

    private static long lastModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ignored) {
            return Long.MIN_VALUE;
        }
    }

    private static void hideDirectoryOnWindows(Path root) {
        if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) return;
        try {
            Files.setAttribute(root, "dos:hidden", true);
        } catch (Exception ignored) {
            // Logging must continue even when the filesystem does not expose DOS attributes.
        }
    }

    public Path path() {
        return path;
    }

    @Override
    public synchronized void close() {
        System.setOut(originalOut);
        System.setErr(originalErr);
        teeOut.flush();
        teeErr.flush();
        file.flush();
        file.close();
    }

    /**
     * PrintStream already knows the correct host console charset. Re-encoding its characters
     * into UTF-8 bytes before writing to the original console corrupts Korean text on CP949/
     * MS949 Windows consoles. This stream delegates character operations independently:
     * the original console keeps its own charset and the file stream remains UTF-8.
     */
    private static final class TeePrintStream extends PrintStream {
        private final PrintStream console;
        private final PrintStream file;

        private TeePrintStream(PrintStream console, PrintStream file) {
            super(OutputStream.nullOutputStream(), true, StandardCharsets.UTF_8);
            this.console = console;
            this.file = file;
        }

        @Override public void flush() { console.flush(); file.flush(); }
        @Override public void close() { flush(); }
        @Override public boolean checkError() { return console.checkError() || file.checkError(); }

        @Override public void write(int value) { console.write(value); file.write(value); }
        @Override public void write(byte[] bytes, int offset, int length) {
            console.write(bytes, offset, length);
            file.write(bytes, offset, length);
        }

        @Override public void print(boolean value) { console.print(value); file.print(value); }
        @Override public void print(char value) { console.print(value); file.print(value); }
        @Override public void print(int value) { console.print(value); file.print(value); }
        @Override public void print(long value) { console.print(value); file.print(value); }
        @Override public void print(float value) { console.print(value); file.print(value); }
        @Override public void print(double value) { console.print(value); file.print(value); }
        @Override public void print(char[] value) { console.print(value); file.print(value); }
        @Override public void print(String value) { console.print(value); file.print(value); }
        @Override public void print(Object value) { console.print(value); file.print(value); }

        @Override public void println() { console.println(); file.println(); }
        @Override public void println(boolean value) { console.println(value); file.println(value); }
        @Override public void println(char value) { console.println(value); file.println(value); }
        @Override public void println(int value) { console.println(value); file.println(value); }
        @Override public void println(long value) { console.println(value); file.println(value); }
        @Override public void println(float value) { console.println(value); file.println(value); }
        @Override public void println(double value) { console.println(value); file.println(value); }
        @Override public void println(char[] value) { console.println(value); file.println(value); }
        @Override public void println(String value) { console.println(value); file.println(value); }
        @Override public void println(Object value) { console.println(value); file.println(value); }

        @Override public PrintStream printf(String format, Object... args) {
            console.printf(format, args);
            file.printf(format, args);
            return this;
        }

        @Override public PrintStream printf(Locale locale, String format, Object... args) {
            console.printf(locale, format, args);
            file.printf(locale, format, args);
            return this;
        }

        @Override public PrintStream format(String format, Object... args) {
            console.format(format, args);
            file.format(format, args);
            return this;
        }

        @Override public PrintStream format(Locale locale, String format, Object... args) {
            console.format(locale, format, args);
            file.format(locale, format, args);
            return this;
        }

        @Override public PrintStream append(CharSequence sequence) {
            console.append(sequence);
            file.append(sequence);
            return this;
        }

        @Override public PrintStream append(CharSequence sequence, int start, int end) {
            console.append(sequence, start, end);
            file.append(sequence, start, end);
            return this;
        }

        @Override public PrintStream append(char value) {
            console.append(value);
            file.append(value);
            return this;
        }
    }
}
