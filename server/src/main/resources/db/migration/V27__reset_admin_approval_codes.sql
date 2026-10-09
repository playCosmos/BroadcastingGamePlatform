-- Approval codes are short-lived capabilities. Existing plaintext
-- pending requests cannot be safely transformed without the original
-- hashing contract, so invalidate them during the one-time upgrade.
DELETE FROM board_admin_approval_request;
