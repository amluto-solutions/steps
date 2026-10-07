/**
 * Settings files the person chose with the file dialogs, part of the recorder bridge: a
 * `.amlsettings` file (Export and Import settings) and a `.amlbackup` (Back up all and Restore).
 */
export interface SettingsFiles {
  readSettingsFile(path: string): Promise<string>;
  writeSettingsFile(path: string, contents: string): Promise<void>;
  readBackupFile(path: string): Promise<string>;
  writeBackupFile(path: string, contents: string): Promise<void>;
}
