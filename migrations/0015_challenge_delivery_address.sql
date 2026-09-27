-- P2-03 · 2026-09-27 裁定授权的唯一 schema 扩展：挑战绑定的实际投递地址
-- 独立于发送后即清除的 otp-mail-payload，AAD = delivery-email-address/auth_challenges.id。
-- 随挑战消费、过期或终止清除，不随发送清除。
ALTER TABLE auth_challenges ADD COLUMN delivery_address_ciphertext BLOB;
