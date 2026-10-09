DELETE FROM board_room
WHERE lifecycle_state = 'TERMINATED'
  AND room_id NOT IN (
    SELECT room_id
    FROM board_room
    WHERE lifecycle_state = 'TERMINATED'
    ORDER BY
      COALESCE(terminated_at, updated_at) DESC,
      room_id DESC
    LIMIT 200
  );
