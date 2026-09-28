package io.github.playcosmos.broadcastinggameplatform.room;

import java.util.List;

import static io.github.playcosmos.broadcastinggameplatform.room.RoomModels.PlayerConfig;

@FunctionalInterface
public interface ParticipantLiveChecker {
    List<PlayerConfig> check(List<PlayerConfig> players);
}
