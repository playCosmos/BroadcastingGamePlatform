package io.github.playcosmos.broadcastinggameplatform.games.drawingguess.application;

import io.github.playcosmos.broadcastinggameplatform.games.drawingguess.domain.DrawerPolicy;
import java.util.List;

public final class DrawerSelector {
    private final DrawerPolicy policy;
    private final String streamerParticipantId;
    private final List<String> participantOrder;

    public DrawerSelector(
        DrawerPolicy policy,
        String streamerParticipantId,
        List<String> participantOrder
    ) {
        this.policy = policy == null
            ? DrawerPolicy.ROTATING_DRAWER
            : policy;
        this.streamerParticipantId = streamerParticipantId == null
            ? ""
            : streamerParticipantId.trim();
        this.participantOrder = participantOrder == null
            ? List.of()
            : participantOrder.stream()
                .filter(value -> value != null && !value.isBlank())
                .map(String::trim)
                .distinct()
                .toList();

        if (
            this.policy == DrawerPolicy.STREAMER_DRAWER
            && this.streamerParticipantId.isBlank()
        ) {
            throw new IllegalArgumentException(
                "streamerParticipantId is required"
            );
        }
        if (
            this.policy == DrawerPolicy.ROTATING_DRAWER
            && this.participantOrder.isEmpty()
        ) {
            throw new IllegalArgumentException(
                "participant order is required"
            );
        }
    }

    public String drawerForRound(int zeroBasedRoundIndex) {
        if (zeroBasedRoundIndex < 0) {
            throw new IllegalArgumentException(
                "round index must not be negative"
            );
        }
        if (policy == DrawerPolicy.STREAMER_DRAWER) {
            return streamerParticipantId;
        }
        return participantOrder.get(
            zeroBasedRoundIndex % participantOrder.size()
        );
    }
}
