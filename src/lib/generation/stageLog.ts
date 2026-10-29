import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../../config';

export interface StageEntry {
  stage: string;
  draftIndex?: number;
  at: string;
  input: unknown;
  output: unknown;
}

export class GenerationStageLog {
  readonly batchId: string;
  readonly entries: StageEntry[] = [];
  private readonly enabled: boolean;
  private readonly filePath: string | null;

  constructor(batchId: string) {
    this.batchId = batchId;
    this.enabled = config.generation.logStages;
    if (!this.enabled) {
      this.filePath = null;
      return;
    }
    const dir = path.isAbsolute(config.generation.logDir)
      ? config.generation.logDir
      : path.resolve(ROOT, config.generation.logDir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.filePath = path.join(dir, `${batchId}.jsonl`);
    } catch (err) {
      // Ephemeral / read-only disks (e.g. some PaaS) must not crash generation.
      console.warn(
        '[generation-log] disk logging disabled (dir not writable):',
        err instanceof Error ? err.message : err,
      );
      this.filePath = null;
    }
  }

  record(stage: string, input: unknown, output: unknown, draftIndex?: number) {
    const entry: StageEntry = {
      stage,
      draftIndex,
      at: new Date().toISOString(),
      input,
      output,
    };
    this.entries.push(entry);
    if (!this.filePath) return;
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      console.warn('[generation-log] failed to write stage log:', err instanceof Error ? err.message : err);
    }
  }

  summary() {
    return {
      batch_id: this.batchId,
      log_file: this.filePath,
      stages: this.entries.map((e) => ({
        stage: e.stage,
        draftIndex: e.draftIndex,
        at: e.at,
      })),
      entries: this.entries,
    };
  }
}
