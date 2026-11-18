/**
 * LLM 抽取契约的类型镜像（`DATA-CONTRACTS.md` §4.2）。
 *
 * 这些是**候选** fact：字段全部是模型给的原始字符串，尚未经过 `FactValidator`
 * 的代码校验。模型没有权限、没有发单能力，只负责把自然语言读成候选（`C6`）。
 */
import type { Instant } from '../../kernel/time/instant.ts';
import type { EtDate } from '../../kernel/time/et-date.ts';
import type { Catalogue } from '../catalogue.ts';
import type { PharmacyRegistry } from '../pharmacy.ts';
import type { FactType } from '../facts/fact.ts';

/** 候选 fact 的类型：八种 fact + 表示「没有变化」的 no_change。 */
export type CandidateFactType = FactType | 'no_change';

/** 一条候选事实（模型输出，未校验）。 */
export interface CandidateFact {
  type: CandidateFactType;
  pharmacy: string | null;
  medication?: string | null;
  dose?: string | null;
  states?: string[];
  per_day?: number | null;
  /** YYYY-MM-DD（America/New_York）。 */
  from_date?: string | null;
  /** YYYY-MM-DD（America/New_York），排他。 */
  until_date?: string | null;
  /** 原始时间措辞，逐字抄写，供确定性解析器复核。 */
  phrase?: string | null;
}

/** 邮件意图。 */
export type EmailIntent =
  | 'stock'
  | 'coverage'
  | 'closure'
  | 'capacity'
  | 'routing'
  | 'unrelated'
  | 'unclear';

/** 一封邮件的抽取结果（模型输出，未校验）。 */
export interface ExtractionResult {
  intent: EmailIntent;
  facts: CandidateFact[];
  correction?: boolean;
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

/** 一次抽取调用的输入（`ARCHITECTURE.md` §5.8）。 */
export interface ExtractionInput {
  /** 来源事件的 event_id；ReplayExtractor 用它回放 fixture（实现补充，见报告）。 */
  eventId: string;
  /** 事件发生时刻 = 「现在」。 */
  at: Instant;
  /** 7 天的周历（只用来拼 WEEK_CALENDAR，与校验窗口无关）。 */
  week: { from: EtDate; toExclusive: EtDate };
  registry: PharmacyRegistry;
  catalogue: Catalogue;
  email: { from: string; subject: string; body: string };
  correctionHint: boolean;
}
