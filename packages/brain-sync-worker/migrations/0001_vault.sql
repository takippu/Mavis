PRAGMA foreign_keys = ON;
CREATE TABLE vaults (id TEXT PRIMARY KEY, head TEXT, generation INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 1, reserved INTEGER NOT NULL DEFAULT 0, budget INTEGER NOT NULL DEFAULT 536870912);
CREATE TABLE devices (id TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(id), credential TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','writer','reader')), revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE objects (id TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(id), epoch INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('document','attachment','manifest')), hash TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 50331648), ready INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE revisions (id TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(id), request TEXT UNIQUE NOT NULL, parent TEXT, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, manifest TEXT NOT NULL, device TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('save','restore','rotate')), envelope TEXT NOT NULL, mac TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(vault,generation));
CREATE TABLE pairings (id TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(id), capability TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('writer','reader')), expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE request_windows(device TEXT PRIMARY KEY REFERENCES devices(id), minute INTEGER NOT NULL, requests INTEGER NOT NULL);
CREATE TRIGGER one_vault BEFORE INSERT ON vaults WHEN EXISTS(SELECT 1 FROM vaults) BEGIN SELECT RAISE(ABORT,'ALREADY_BOOTSTRAPPED'); END;
CREATE TRIGGER object_budget BEFORE INSERT ON objects BEGIN
  SELECT CASE WHEN NEW.epoch NOT IN ((SELECT epoch FROM vaults WHERE id=NEW.vault),(SELECT epoch+1 FROM vaults WHERE id=NEW.vault)) THEN RAISE(ABORT,'WRONG_EPOCH') END;
  SELECT CASE WHEN NEW.bytes + (SELECT reserved FROM vaults WHERE id=NEW.vault) > (SELECT budget FROM vaults WHERE id=NEW.vault) THEN RAISE(ABORT,'QUOTA_EXCEEDED') END;
END;
CREATE TRIGGER object_account AFTER INSERT ON objects BEGIN UPDATE vaults SET reserved=reserved+NEW.bytes WHERE id=NEW.vault; END;
CREATE TRIGGER object_unaccount AFTER DELETE ON objects BEGIN UPDATE vaults SET reserved=reserved-OLD.bytes WHERE id=OLD.vault; END;
CREATE TRIGGER device_limit BEFORE INSERT ON devices BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM devices WHERE vault=NEW.vault AND revoked=0)>=10 THEN RAISE(ABORT,'DEVICE_LIMIT') END;
END;
CREATE TRIGGER revision_guard BEFORE INSERT ON revisions BEGIN
 SELECT CASE WHEN NEW.parent IS NOT (SELECT head FROM vaults WHERE id=NEW.vault) OR NEW.generation != (SELECT generation+1 FROM vaults WHERE id=NEW.vault) THEN RAISE(ABORT,'STALE_HEAD') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM devices WHERE id=NEW.device AND vault=NEW.vault AND revoked=0 AND role IN ('owner','writer')) THEN RAISE(ABORT,'FORBIDDEN') END;
 SELECT CASE WHEN (NEW.operation='rotate' AND (NEW.epoch != (SELECT epoch+1 FROM vaults WHERE id=NEW.vault) OR NOT EXISTS(SELECT 1 FROM devices WHERE id=NEW.device AND role='owner' AND revoked=0))) OR (NEW.operation!='rotate' AND NEW.epoch != (SELECT epoch FROM vaults WHERE id=NEW.vault)) THEN RAISE(ABORT,'WRONG_EPOCH') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM objects WHERE id=NEW.manifest AND vault=NEW.vault AND epoch=NEW.epoch AND kind='manifest' AND ready=1) THEN RAISE(ABORT,'INCOMPLETE_MANIFEST') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(json_extract(NEW.envelope,'$.objects')) AS refs WHERE NOT EXISTS(SELECT 1 FROM objects WHERE id=json_extract(refs.value,'$.id') AND vault=NEW.vault AND epoch=NEW.epoch AND ready=1 AND hash=json_extract(refs.value,'$.hash') AND bytes=json_extract(refs.value,'$.bytes') AND kind=json_extract(refs.value,'$.kind'))) THEN RAISE(ABORT,'INCOMPLETE_OBJECTS') END;
END;
CREATE TRIGGER revision_head AFTER INSERT ON revisions BEGIN UPDATE vaults SET head=NEW.id,generation=NEW.generation,epoch=NEW.epoch WHERE id=NEW.vault; END;
CREATE TRIGGER referenced_object BEFORE DELETE ON objects WHEN EXISTS(SELECT 1 FROM revisions,json_each(json_extract(revisions.envelope,'$.objects')) refs WHERE revisions.vault=OLD.vault AND json_extract(refs.value,'$.id')=OLD.id) BEGIN SELECT RAISE(ABORT,'REFERENCED_OBJECT'); END;
CREATE TRIGGER pairing_once BEFORE UPDATE OF consumed ON pairings WHEN OLD.consumed=1 OR OLD.expires<unixepoch() BEGIN SELECT RAISE(ABORT,'PAIRING_EXPIRED'); END;
CREATE TRIGGER last_owner BEFORE UPDATE OF revoked ON devices WHEN OLD.role='owner' AND NEW.revoked=1 BEGIN SELECT RAISE(ABORT,'OWNER_RECOVERY_REQUIRED'); END;
