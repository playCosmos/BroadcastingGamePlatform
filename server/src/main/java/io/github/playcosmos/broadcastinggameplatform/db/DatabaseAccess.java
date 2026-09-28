package io.github.playcosmos.broadcastinggameplatform.db;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;

public interface DatabaseAccess {
    Path path();
    Connection open() throws SQLException;
}
