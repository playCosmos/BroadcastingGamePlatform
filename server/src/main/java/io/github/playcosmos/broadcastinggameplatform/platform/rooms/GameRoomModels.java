package io.github.playcosmos.broadcastinggameplatform.platform.rooms;

import java.util.List;
import java.util.Objects;

/** Immutable, cross-game room occupancy and membership projections (R1). */
public final class GameRoomModels {
    private GameRoomModels() {}

    public enum SeatRole { PLAYER, SPECTATOR }
    public enum MemberStatus { JOINED, DISCONNECTED_GRACE, LEFT, KICKED }
    public enum RoomState { OPEN_LOBBY, PLAYING, POST_GAME, CLOSED }

    public record Member(
        String memberId, String actorId, String displayName,
        SeatRole seatRole, MemberStatus status, boolean ready,
        String graceExpiresAt, String joinedAt
    ) {
        public Member {
            Objects.requireNonNull(memberId, "memberId");
            Objects.requireNonNull(actorId, "actorId");
            Objects.requireNonNull(displayName, "displayName");
            Objects.requireNonNull(seatRole, "seatRole");
            Objects.requireNonNull(status, "status");
        }

        /** A temporarily disconnected member still occupies their one seat. */
        public boolean occupies() {
            return status == MemberStatus.JOINED
                || status == MemberStatus.DISCONNECTED_GRACE;
        }
    }

    public record Room(
        String roomId, String gameId, String roomCode,
        String ownerMemberId, RoomState state, int maxPlayers,
        int maxRoomMembers, long version, List<Member> members
    ) {
        public Room {
            Objects.requireNonNull(roomId, "roomId");
            Objects.requireNonNull(gameId, "gameId");
            Objects.requireNonNull(roomCode, "roomCode");
            Objects.requireNonNull(ownerMemberId, "ownerMemberId");
            Objects.requireNonNull(state, "state");
            members = List.copyOf(members);
            if (maxPlayers < 1 || maxRoomMembers < maxPlayers || version < 0) {
                throw new IllegalArgumentException("invalid room capacity or version");
            }
            long owners = members.stream()
                .filter(m -> m.memberId().equals(ownerMemberId)).count();
            if (owners != 1) throw new IllegalArgumentException("room requires one owner");
            if (playerCount() > maxPlayers || memberCount() > maxRoomMembers) {
                throw new IllegalArgumentException("room occupancy exceeds capacity");
            }
        }

        /** Count unique membership rows, not sockets, tabs or host roles. */
        public int memberCount() {
            return (int) members.stream().filter(Member::occupies).count();
        }

        public int playerCount() {
            return (int) members.stream().filter(m -> m.occupies()
                && m.seatRole() == SeatRole.PLAYER).count();
        }

        public int spectatorCount() { return memberCount() - playerCount(); }

        public Member memberForActor(String actorId) {
            return members.stream().filter(m -> m.actorId().equals(actorId))
                .findFirst().orElse(null);
        }

        public Member host() {
            return members.stream().filter(m -> m.memberId().equals(ownerMemberId))
                .findFirst().orElseThrow();
        }
    }
}
