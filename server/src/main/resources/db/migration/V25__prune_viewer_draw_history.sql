DELETE FROM viewer_draw_machine_map_revision
WHERE (map_id, revision) IN (
  SELECT map_id, revision
  FROM (
    SELECT
      map_id,
      revision,
      ROW_NUMBER() OVER (
        PARTITION BY map_id
        ORDER BY revision DESC
      ) AS retained_rank
    FROM viewer_draw_machine_map_revision
  )
  WHERE retained_rank > 50
);

DELETE FROM viewer_draw_marble_audit
WHERE audit_id NOT IN (
  SELECT audit_id
  FROM viewer_draw_marble_audit
  ORDER BY created_at DESC, audit_id DESC
  LIMIT 200
);
