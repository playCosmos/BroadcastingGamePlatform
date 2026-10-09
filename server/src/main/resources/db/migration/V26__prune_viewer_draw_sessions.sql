DELETE FROM viewer_draw_session
WHERE state IN ('COMPLETED', 'CANCELLED')
  AND session_id NOT IN (
    SELECT session_id
    FROM viewer_draw_session
    WHERE state IN ('COMPLETED', 'CANCELLED')
    ORDER BY
      COALESCE(completed_at, updated_at) DESC,
      session_id DESC
    LIMIT 200
  );
