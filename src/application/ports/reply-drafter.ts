/**
 * 草拟回复端口（加分项，`ARCHITECTURE.md` §18）。
 *
 * 默认实现是 `NullDrafter`（`draft_reply` 恒为 null）；核心不依赖它。
 */
import type { SamEntry } from '../../domain/email/sam-list.ts';

export interface ReplyDrafter {
  draft(entry: SamEntry): Promise<string | null>;
}

/** 默认实现：不草拟任何回复。 */
export class NullDrafter implements ReplyDrafter {
  async draft(_entry: SamEntry): Promise<string | null> {
    return null;
  }
}
