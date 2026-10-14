-- tier: 1 長文, 2 ナレッジ, 3 日記。NULL は未判定。
-- tier_confidence: Clef が返した confidence。人が決めた行は NULL。
-- tier_locked: 1 のとき自動の判定は書き込まない。
ALTER TABLE posts ADD COLUMN tier INTEGER CHECK (tier IN (1, 2, 3));
ALTER TABLE posts ADD COLUMN tier_confidence REAL CHECK (tier_confidence BETWEEN 0 AND 1);
ALTER TABLE posts ADD COLUMN tier_locked INTEGER NOT NULL DEFAULT 0;
