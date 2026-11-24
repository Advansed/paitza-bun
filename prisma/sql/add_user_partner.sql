-- Partner referral: id пригласившего пользователя (t_users.id)
ALTER TABLE t_users ADD COLUMN IF NOT EXISTS partner CHAR(36) NULL;
