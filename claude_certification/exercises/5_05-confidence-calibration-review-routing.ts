// Exercise 5_05 - Field-level confidence, calibration and review routing (Task Statement 5.5)
// Run: npx tsx 5_05-confidence-calibration-review-routing.ts
//
// Pure simulation - no API calls and no .env needed. 4_06 measured a LIVE
// model's self-reported confidence; this exercise isolates the maths that sits
// around any such model: the aggregate-metrics trap, per-segment calibration,
// stratified sampling of the automated blind spot, and calibrated review
// routing. The "model" is a seeded mock whose miscalibration is PLANTED per
// document type and field (P(correct) = reported confidence + bias), so every
// effect the task statement describes is reproducible and machine-checked.
// Same seed -> identical numbers on every run.
//
// Steps:
//   1. Mock extraction: 4 document types x 3 fields (vendorName/date/amount),
//      each field carrying its OWN confidence; distributions differ sharply
//      by type (standard invoices ~0.95-0.98 down to international ~0.50-0.63)
//   2. Accuracy tracking per document type per field vs the aggregate row:
//      ~90% overall masks ~42% segments, because invoices are 80% of volume
//   3. Calibration curves against ground truth: confidence bands per
//      type-field segment -> measured accuracy; the same reported band means
//      different actual accuracy in different segments
//   4. Stratified sampling across type x confidence strata INCLUDING the
//      high-confidence automated items; a simulated week-2 drift (invoice
//      amounts degrade at unchanged confidence) is caught ONLY there
//   5. Review router: a binary min-heap ordered by the weakest field's
//      CALIBRATED confidence, reordering dynamically as items arrive - never
//      chronological, and provably different from raw-confidence ordering

// ---------------------------------------------------------------------------
// Seeded randomness - reproducibility is what makes the checks assertable
// ---------------------------------------------------------------------------

const SEED = 20260803;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);

function randomInt(maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function pickOne<T>(items: T[]): T {
  return items[randomInt(items.length)];
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Step 1 config: document types, fields and the PLANTED miscalibration
// ---------------------------------------------------------------------------

type DocumentType = "invoice" | "scannedPdf" | "receipt" | "international";
type FieldName = "vendorName" | "date" | "amount";

const DOC_TYPES: DocumentType[] = ["invoice", "scannedPdf", "receipt", "international"];
const FIELDS: FieldName[] = ["vendorName", "date", "amount"];

interface FieldProfile {
  baseConfidence: number;
  // The planted miscalibration: P(correct) = reported confidence + bias.
  // Positive = the mock is UNDER-confident (clean invoices), negative =
  // OVER-confident - exactly where real extraction models overstate
  // themselves: handwriting, low-DPI scans, unfamiliar international formats.
  // Per FIELD, not per type: the exam point is that 0.90 means one thing for
  // dates and another for amounts even on the same document.
  calibrationBias: number;
}

interface TypeProfile {
  share: number; // of corpus volume - invoices dominate, which IS the trap
  label: string;
  fields: Record<FieldName, FieldProfile>;
}

const PROFILES: Record<DocumentType, TypeProfile> = {
  invoice: {
    share: 0.8,
    label: "standard invoice",
    fields: {
      vendorName: { baseConfidence: 0.98, calibrationBias: +0.02 },
      date: { baseConfidence: 0.95, calibrationBias: +0.04 },
      amount: { baseConfidence: 0.97, calibrationBias: +0.03 },
    },
  },
  scannedPdf: {
    share: 0.07,
    label: "low-DPI scanned PDF",
    fields: {
      vendorName: { baseConfidence: 0.8, calibrationBias: -0.02 },
      date: { baseConfidence: 0.72, calibrationBias: -0.1 },
      amount: { baseConfidence: 0.69, calibrationBias: -0.04 },
    },
  },
  receipt: {
    share: 0.08,
    label: "handwritten receipt",
    fields: {
      vendorName: { baseConfidence: 0.71, calibrationBias: -0.05 },
      date: { baseConfidence: 0.6, calibrationBias: -0.03 },
      amount: { baseConfidence: 0.55, calibrationBias: -0.12 },
    },
  },
  international: {
    share: 0.05,
    label: "international document",
    fields: {
      vendorName: { baseConfidence: 0.63, calibrationBias: -0.18 },
      date: { baseConfidence: 0.5, calibrationBias: -0.06 },
      amount: { baseConfidence: 0.52, calibrationBias: -0.1 },
    },
  },
};

const CORPUS_SIZE = 4000;
const CONFIDENCE_JITTER = 0.1;

// ---------------------------------------------------------------------------
// Source documents and ground truth
// ---------------------------------------------------------------------------

const VENDORS: Record<DocumentType, string[]> = {
  invoice: ["Acme Office Supply Co", "Northwind Logistics Inc", "Cascade Software LLC", "Ironwood Facilities Group", "Beacon Print & Media"],
  scannedPdf: ["Harbor Freight Services", "Pinnacle Equipment Rental", "Summit Industrial Parts", "Lakeside Catering Co"],
  receipt: ["Rosie's Diner", "Corner Hardware", "Blue Bike Courier", "Maple Street Florist"],
  international: ["Müller & Söhne GmbH", "Société Générale de Fournitures", "Nakamura Trading K.K.", "Fábrica de Papel São Paulo", "Østergaard Kontor ApS"],
};

interface SourceDocument {
  id: string;
  type: DocumentType;
  truth: Record<FieldName, string>;
}

function makeDocument(idPrefix: string, type: DocumentType, index: number): SourceDocument {
  const month = String(1 + randomInt(12)).padStart(2, "0");
  const day = String(1 + randomInt(28)).padStart(2, "0");
  return {
    id: `${idPrefix}-${type}-${String(index).padStart(4, "0")}`,
    type,
    truth: {
      vendorName: pickOne(VENDORS[type]),
      date: `2026-${month}-${day}`,
      amount: (50 + rng() * 9450).toFixed(2),
    },
  };
}

// Plausible OCR-style mistakes, each guaranteed != truth, so string equality
// against ground truth is a faithful correctness signal.

function corruptVendor(value: string): string {
  const chars = [...value];
  if (chars.length < 2) return value + "?";
  const i = randomInt(chars.length - 1);
  [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  const candidate = chars.join("");
  return candidate === value ? `${value} Ltd` : candidate; // swapped a repeated char
}

function corruptDate(value: string): string {
  const day = Number(value.slice(8, 10));
  const shifted = ((day - 1 + 1 + randomInt(5)) % 28) + 1; // never lands back on `day`
  return `${value.slice(0, 8)}${String(shifted).padStart(2, "0")}`;
}

function corruptAmount(value: string): string {
  const digitPositions: number[] = [];
  [...value].forEach((ch, i) => {
    if (ch >= "0" && ch <= "9") digitPositions.push(i);
  });
  const pos = pickOne(digitPositions);
  const digit = Number(value[pos]);
  const replacement = String((digit + 1 + randomInt(9)) % 10); // any digit except the original
  return value.slice(0, pos) + replacement + value.slice(pos + 1);
}

const CORRUPTERS: Record<FieldName, (value: string) => string> = {
  vendorName: corruptVendor,
  date: corruptDate,
  amount: corruptAmount,
};

// ---------------------------------------------------------------------------
// Step 1: the mock extraction system
// ---------------------------------------------------------------------------

interface FieldExtraction {
  value: string;
  confidence: number; // 0.0-1.0, per field - raw and UNCALIBRATED
}

interface Extraction {
  id: string;
  documentType: DocumentType;
  arrivalSeq: number; // chronological intake order - what the queue must NOT serve by
  fields: Record<FieldName, FieldExtraction>;
  overallConfidence: number;
}

/** Step 4 hook: returns an accuracy override for a (type, field) segment, or null. */
type DriftRule = (type: DocumentType, field: FieldName) => number | null;

const NO_DRIFT: DriftRule = () => null;

function extractField(document: SourceDocument, field: FieldName, drift: DriftRule): FieldExtraction {
  const profile = PROFILES[document.type].fields[field];
  const confidence = round3(clamp(profile.baseConfidence + (rng() * 2 - 1) * CONFIDENCE_JITTER, 0.02, 0.995));
  // Correctness is drawn from confidence + bias, NOT from confidence itself -
  // that gap is what Step 3 exists to measure. A drift override models a novel
  // error pattern the confidence score knows nothing about.
  const accuracy = drift(document.type, field) ?? clamp(confidence + profile.calibrationBias, 0.02, 0.995);
  const truthValue = document.truth[field];
  const correct = rng() < accuracy;
  return { value: correct ? truthValue : CORRUPTERS[field](truthValue), confidence };
}

function mockExtraction(document: SourceDocument, arrivalSeq: number, drift: DriftRule): Extraction {
  const vendorName = extractField(document, "vendorName", drift);
  const date = extractField(document, "date", drift);
  const amount = extractField(document, "amount", drift);
  return {
    id: document.id,
    documentType: document.type,
    arrivalSeq,
    fields: { vendorName, date, amount },
    overallConfidence: round3((vendorName.confidence + date.confidence + amount.confidence) / 3),
  };
}

interface Corpus {
  extractions: Extraction[];
  truthById: Record<string, Record<FieldName, string>>;
}

function buildCorpus(idPrefix: string, drift: DriftRule): Corpus {
  const documents: SourceDocument[] = [];
  for (const type of DOC_TYPES) {
    const count = Math.round(CORPUS_SIZE * PROFILES[type].share);
    for (let i = 0; i < count; i++) documents.push(makeDocument(idPrefix, type, i));
  }
  // Arrival order is interleaved across types, like a real intake queue -
  // so "chronological" and "by type" orderings are visibly different things.
  const mixed = shuffled(documents);
  const truthById: Record<string, Record<FieldName, string>> = {};
  for (const doc of mixed) truthById[doc.id] = doc.truth;
  return { extractions: mixed.map((doc, seq) => mockExtraction(doc, seq, drift)), truthById };
}

function fieldIsCorrect(extraction: Extraction, field: FieldName, truthById: Record<string, Record<FieldName, string>>): boolean {
  return extraction.fields[field].value === truthById[extraction.id][field];
}

// ---------------------------------------------------------------------------
// Step 2: accuracy tracking per document type per field - never just aggregate
// ---------------------------------------------------------------------------

interface CellStats {
  correct: number;
  total: number;
}

function emptyCell(): CellStats {
  return { correct: 0, total: 0 };
}

function accuracyOf(cell: CellStats): number {
  return cell.total === 0 ? 0 : cell.correct / cell.total;
}

function emptyRow(): Record<FieldName, CellStats> {
  return { vendorName: emptyCell(), date: emptyCell(), amount: emptyCell() };
}

type AccuracyTable = Record<DocumentType, Record<FieldName, CellStats>>;

function trackAccuracy(extractions: Extraction[], truthById: Record<string, Record<FieldName, string>>): AccuracyTable {
  const table: AccuracyTable = { invoice: emptyRow(), scannedPdf: emptyRow(), receipt: emptyRow(), international: emptyRow() };
  for (const ext of extractions) {
    for (const field of FIELDS) {
      const cell = table[ext.documentType][field];
      cell.total++;
      if (fieldIsCorrect(ext, field, truthById)) cell.correct++;
    }
  }
  return table;
}

interface SegmentAccuracy {
  type: DocumentType;
  field: FieldName;
  accuracy: number;
  total: number;
}

function allSegments(table: AccuracyTable): SegmentAccuracy[] {
  const segments: SegmentAccuracy[] = [];
  for (const type of DOC_TYPES) {
    for (const field of FIELDS) {
      const cell = table[type][field];
      segments.push({ type, field, accuracy: accuracyOf(cell), total: cell.total });
    }
  }
  return segments;
}

function aggregateAccuracy(table: AccuracyTable): number {
  const combined = emptyCell();
  for (const segment of allSegments(table)) {
    combined.correct += segment.accuracy * segment.total;
    combined.total += segment.total;
  }
  return accuracyOf(combined);
}

function printAccuracyTable(table: AccuracyTable, extractions: Extraction[]): void {
  const countByType = { invoice: 0, scannedPdf: 0, receipt: 0, international: 0 };
  for (const ext of extractions) countByType[ext.documentType]++;

  console.log(`  ${"document type".padEnd(24)}${"volume".padStart(8)}${FIELDS.map((f) => f.padStart(12)).join("")}${"all fields".padStart(12)}`);
  const aggregateByField = emptyRow();
  for (const type of DOC_TYPES) {
    const rowCombined = emptyCell();
    const cells = FIELDS.map((field) => {
      const cell = table[type][field];
      rowCombined.correct += cell.correct;
      rowCombined.total += cell.total;
      aggregateByField[field].correct += cell.correct;
      aggregateByField[field].total += cell.total;
      return pct(accuracyOf(cell)).padStart(12);
    });
    const volume = countByType[type] / extractions.length;
    console.log(`  ${PROFILES[type].label.padEnd(24)}${pct(volume).padStart(8)}${cells.join("")}${pct(accuracyOf(rowCombined)).padStart(12)}`);
  }
  const aggregateCells = FIELDS.map((field) => pct(accuracyOf(aggregateByField[field])).padStart(12));
  console.log(`  ${"AGGREGATE".padEnd(24)}${"100.0%".padStart(8)}${aggregateCells.join("")}${pct(aggregateAccuracy(table)).padStart(12)}`);
}

// ---------------------------------------------------------------------------
// Step 3: calibration - confidence bands vs measured accuracy, per segment
// ---------------------------------------------------------------------------

const BAND_SIZE = 0.1;
// A band with too few labelled samples gives a noisy accuracy estimate; the
// lookup folds such bands into the nearest reliable one instead of using them.
const MIN_BAND_N = 25;

function segmentKey(type: DocumentType, field: FieldName): string {
  return `${type}/${field}`;
}

function bandOf(confidence: number): number {
  return Math.min(9, Math.floor(confidence * 10 + 1e-9)) / 10;
}

type CalibrationTable = Map<string, Map<number, CellStats>>;

function buildCalibration(extractions: Extraction[], truthById: Record<string, Record<FieldName, string>>): CalibrationTable {
  const table: CalibrationTable = new Map();
  for (const ext of extractions) {
    for (const field of FIELDS) {
      const key = segmentKey(ext.documentType, field);
      let segment = table.get(key);
      if (!segment) {
        segment = new Map();
        table.set(key, segment);
      }
      const band = bandOf(ext.fields[field].confidence);
      let cell = segment.get(band);
      if (!cell) {
        cell = emptyCell();
        segment.set(band, cell);
      }
      cell.total++;
      if (fieldIsCorrect(ext, field, truthById)) cell.correct++;
    }
  }
  return table;
}

interface BandPoint {
  band: number; // lower edge, e.g. 0.6 for the 0.6-0.7 band
  accuracy: number;
  total: number;
}

function reliableBands(calibration: CalibrationTable, type: DocumentType, field: FieldName): BandPoint[] {
  const segment = calibration.get(segmentKey(type, field));
  if (!segment) return [];
  const points: BandPoint[] = [];
  for (const [band, cell] of segment) {
    if (cell.total >= MIN_BAND_N) points.push({ band, accuracy: accuracyOf(cell), total: cell.total });
  }
  return points.sort((a, b) => a.band - b.band);
}

/**
 * The calibration lookup: (document type, field, reported confidence) ->
 * expected actual accuracy. Falls back to the nearest reliable band, and to
 * the raw confidence only when the segment has no validation data at all.
 */
function calibratedAccuracy(calibration: CalibrationTable, type: DocumentType, field: FieldName, confidence: number): number {
  const bands = reliableBands(calibration, type, field);
  if (bands.length === 0) return confidence;
  let best = bands[0];
  for (const point of bands) {
    if (Math.abs(point.band + BAND_SIZE / 2 - confidence) < Math.abs(best.band + BAND_SIZE / 2 - confidence)) best = point;
  }
  return best.accuracy;
}

interface BandEntry {
  type: DocumentType;
  field: FieldName;
  accuracy: number;
  total: number;
}

/** The band populated by >= 2 segments whose measured accuracies diverge the most. */
function mostDivergentBand(calibration: CalibrationTable): { band: number; entries: BandEntry[]; spread: number } | null {
  let best: { band: number; entries: BandEntry[]; spread: number } | null = null;
  for (let tenths = 0; tenths <= 9; tenths++) {
    const band = tenths / 10;
    const entries: BandEntry[] = [];
    for (const type of DOC_TYPES) {
      for (const field of FIELDS) {
        const point = reliableBands(calibration, type, field).find((p) => Math.abs(p.band - band) < 1e-6);
        if (point) entries.push({ type, field, accuracy: point.accuracy, total: point.total });
      }
    }
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.accuracy - b.accuracy);
    const spread = entries[entries.length - 1].accuracy - entries[0].accuracy;
    if (!best || spread > best.spread) best = { band, entries, spread };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Step 4: stratified sampling - the high-confidence blind spot
// ---------------------------------------------------------------------------

// Above this raw overall confidence an extraction is automated (no human sees
// it) - which is exactly why it MUST stay in the verification sample.
const RAW_HIGH_CONFIDENCE = 0.8;
const SAMPLE_RATE = 0.05;

interface Stratum {
  key: string; // "<type>/<high|low>"
  items: Extraction[];
  sampled: Extraction[];
}

function stratifiedSample(extractions: Extraction[], sampleRate: number): Stratum[] {
  const groups = new Map<string, Extraction[]>();
  for (const ext of extractions) {
    const key = `${ext.documentType}/${ext.overallConfidence >= RAW_HIGH_CONFIDENCE ? "high" : "low"}`;
    const list = groups.get(key);
    if (list) list.push(ext);
    else groups.set(key, [ext]);
  }
  const strata: Stratum[] = [];
  for (const [key, items] of groups) {
    // Proportional to stratum volume, but never zero: every stratum - however
    // small - keeps at least one item under ongoing verification.
    const n = Math.max(1, Math.ceil(items.length * sampleRate));
    strata.push({ key, items, sampled: shuffled(items).slice(0, n) });
  }
  return strata.sort((a, b) => a.key.localeCompare(b.key));
}

// Week 2's novel error pattern: invoice amounts degrade to 75% accuracy while
// the mock keeps reporting ~0.97 confidence. Low-confidence review never sees
// these items; only the high-confidence stratum sample can.
const DRIFTED_AMOUNT_ACCURACY = 0.75;
const WEEK2_DRIFT: DriftRule = (type, field) => (type === "invoice" && field === "amount" ? DRIFTED_AMOUNT_ACCURACY : null);

const DRIFT_ALARM_FACTOR = 3; // observed error rate >= 3x calibrated expectation -> alarm

// ---------------------------------------------------------------------------
// Step 5: the review router - a min-heap over CALIBRATED confidence
// ---------------------------------------------------------------------------

function weakestCalibratedField(calibration: CalibrationTable, extraction: Extraction): { field: FieldName; accuracy: number } {
  // The weakest field drives review need: an invoice whose amount is suspect
  // needs a human even when vendor and date are certain.
  let weakest: { field: FieldName; accuracy: number } = { field: "vendorName", accuracy: Number.POSITIVE_INFINITY };
  for (const field of FIELDS) {
    const accuracy = calibratedAccuracy(calibration, extraction.documentType, field, extraction.fields[field].confidence);
    if (accuracy < weakest.accuracy) weakest = { field, accuracy };
  }
  return weakest;
}

interface QueueItem {
  extraction: Extraction;
  calibratedConfidence: number;
  weakestField: FieldName;
}

class ReviewQueue {
  private heap: QueueItem[] = [];

  constructor(private readonly calibration: CalibrationTable) {}

  get size(): number {
    return this.heap.length;
  }

  /** Queue contents, unordered - the runner uses it to verify each pop was the minimum. */
  snapshot(): QueueItem[] {
    return [...this.heap];
  }

  add(extraction: Extraction): QueueItem {
    const weakest = weakestCalibratedField(this.calibration, extraction);
    const item: QueueItem = { extraction, calibratedConfidence: weakest.accuracy, weakestField: weakest.field };
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
    return item;
  }

  /** The highest-uncertainty item remaining - NEVER the oldest. */
  next(): QueueItem | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (last !== undefined && this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  // Lowest calibrated confidence first; arrival order only breaks exact ties.
  private higherPriority(a: QueueItem, b: QueueItem): boolean {
    if (a.calibratedConfidence !== b.calibratedConfidence) return a.calibratedConfidence < b.calibratedConfidence;
    return a.extraction.arrivalSeq < b.extraction.arrivalSeq;
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.higherPriority(this.heap[index], this.heap[parent])) return;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }

  private siftDown(index: number): void {
    for (;;) {
      let best = index;
      for (const child of [index * 2 + 1, index * 2 + 2]) {
        if (child < this.heap.length && this.higherPriority(this.heap[child], this.heap[best])) best = child;
      }
      if (best === index) return;
      [this.heap[index], this.heap[best]] = [this.heap[best], this.heap[index]];
      index = best;
    }
  }
}

/** Hand-crafted arrivals so the demo's raw-vs-calibrated inversion is guaranteed on any seed. */
function demoExtraction(id: string, type: DocumentType, confidences: Record<FieldName, number>, arrivalSeq: number): Extraction {
  return {
    id,
    documentType: type,
    arrivalSeq,
    fields: {
      vendorName: { value: "(demo)", confidence: confidences.vendorName },
      date: { value: "(demo)", confidence: confidences.date },
      amount: { value: "(demo)", confidence: confidences.amount },
    },
    overallConfidence: round3((confidences.vendorName + confidences.date + confidences.amount) / 3),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

function main(): void {
  // --- Step 1 ---------------------------------------------------------------
  console.log("=== Step 1: mock extraction - field-level confidence per document type ===");
  const week1 = buildCorpus("wk1", NO_DRIFT);

  const meanOverallByType = { invoice: 0, scannedPdf: 0, receipt: 0, international: 0 };
  const meanFieldByType: Record<DocumentType, Record<FieldName, number>> = {
    invoice: { vendorName: 0, date: 0, amount: 0 },
    scannedPdf: { vendorName: 0, date: 0, amount: 0 },
    receipt: { vendorName: 0, date: 0, amount: 0 },
    international: { vendorName: 0, date: 0, amount: 0 },
  };
  const countByType = { invoice: 0, scannedPdf: 0, receipt: 0, international: 0 };
  for (const ext of week1.extractions) {
    countByType[ext.documentType]++;
    meanOverallByType[ext.documentType] += ext.overallConfidence;
    for (const field of FIELDS) meanFieldByType[ext.documentType][field] += ext.fields[field].confidence;
  }
  console.log(`  mean reported confidence over ${week1.extractions.length} documents:`);
  console.log(`  ${"document type".padEnd(24)}${"n".padStart(6)}${FIELDS.map((f) => f.padStart(12)).join("")}${"overall".padStart(10)}`);
  for (const type of DOC_TYPES) {
    const n = countByType[type];
    const cells = FIELDS.map((field) => (meanFieldByType[type][field] / n).toFixed(3).padStart(12));
    console.log(`  ${PROFILES[type].label.padEnd(24)}${String(n).padStart(6)}${cells.join("")}${(meanOverallByType[type] / n).toFixed(3).padStart(10)}`);
  }
  const sampleExt = week1.extractions.find((ext) => ext.documentType === "receipt");
  if (sampleExt) {
    const rendered = FIELDS.map((field) => `${field}="${sampleExt.fields[field].value}" (conf ${sampleExt.fields[field].confidence.toFixed(2)})`).join(", ");
    console.log(`  sample extraction (${sampleExt.id}): ${rendered}`);
  }

  const confidencesInRange = week1.extractions.every((ext) => FIELDS.every((field) => ext.fields[field].confidence >= 0 && ext.fields[field].confidence <= 1));
  const meanInvoice = meanOverallByType.invoice / countByType.invoice;
  const meanScanned = meanOverallByType.scannedPdf / countByType.scannedPdf;
  const meanReceipt = meanOverallByType.receipt / countByType.receipt;
  const meanInternational = meanOverallByType.international / countByType.international;

  // --- Step 2 ---------------------------------------------------------------
  console.log("\n=== Step 2: accuracy by document type and field - the aggregate metrics trap ===");
  const accuracy = trackAccuracy(week1.extractions, week1.truthById);
  printAccuracyTable(accuracy, week1.extractions);

  const aggregate = aggregateAccuracy(accuracy);
  const segments = allSegments(accuracy).sort((a, b) => a.accuracy - b.accuracy);
  const worst = segments[0];
  console.log(`\n  the trap: the AGGREGATE reads ${pct(aggregate)} - an "excellent" system - while ${worst.type}/${worst.field}`);
  console.log(`  runs at ${pct(worst.accuracy)}. Invoices are ${pct(countByType.invoice / week1.extractions.length)} of volume, so their accuracy IS the aggregate;`);
  console.log(`  automating on the aggregate would auto-approve a segment that is wrong ${pct(1 - worst.accuracy)} of the time.`);

  // --- Step 3 ---------------------------------------------------------------
  console.log("\n=== Step 3: calibration - reported confidence vs measured accuracy, per segment ===");
  const calibration = buildCalibration(week1.extractions, week1.truthById);
  console.log(`  measured accuracy per reported-confidence band (bands with n >= ${MIN_BAND_N} only):`);
  for (const type of DOC_TYPES) {
    for (const field of FIELDS) {
      const points = reliableBands(calibration, type, field);
      if (points.length === 0) continue;
      const rendered = points.map((p) => `${p.band.toFixed(1)}-${(p.band + BAND_SIZE).toFixed(1)}: ${pct(p.accuracy)} (n=${p.total})`).join("   ");
      console.log(`    ${segmentKey(type, field).padEnd(28)}${rendered}`);
    }
  }

  const divergence = mostDivergentBand(calibration);
  if (divergence) {
    console.log(`\n  the same reported band means different things - band ${divergence.band.toFixed(1)}-${(divergence.band + BAND_SIZE).toFixed(1)}:`);
    for (const entry of divergence.entries) {
      console.log(`    ${segmentKey(entry.type, entry.field).padEnd(28)}actual accuracy ${pct(entry.accuracy)} (n=${entry.total})`);
    }
    console.log(`    -> spread of ${(divergence.spread * 100).toFixed(1)} points inside ONE confidence band; a single global threshold cannot route this.`);
  }
  const lookupA = calibratedAccuracy(calibration, "international", "vendorName", 0.72);
  const lookupB = calibratedAccuracy(calibration, "receipt", "vendorName", 0.72);
  console.log(`  lookup: reported 0.72 on international/vendorName -> expect ${pct(lookupA)}; on receipt/vendorName -> expect ${pct(lookupB)}`);

  // --- Step 4 ---------------------------------------------------------------
  console.log("\n=== Step 4: stratified sampling - keep verifying the automated high-confidence items ===");
  const week1Strata = stratifiedSample(week1.extractions, SAMPLE_RATE);
  console.log(`  strata (raw overall confidence >= ${RAW_HIGH_CONFIDENCE.toFixed(2)} = "high" = automated, no human review):`);
  for (const stratum of week1Strata) {
    console.log(`    ${stratum.key.padEnd(24)}${String(stratum.items.length).padStart(5)} items -> ${String(stratum.sampled.length).padStart(4)} sampled`);
  }
  const week1SampleTotal = week1Strata.reduce((sum, s) => sum + s.sampled.length, 0);
  const typeShareOk = DOC_TYPES.every((type) => {
    const volumeShare = countByType[type] / week1.extractions.length;
    const sampleShare = week1Strata.filter((s) => s.key.startsWith(`${type}/`)).reduce((sum, s) => sum + s.sampled.length, 0) / week1SampleTotal;
    console.log(`    ${type.padEnd(24)}sample share ${pct(sampleShare)} vs volume share ${pct(volumeShare)}`);
    return Math.abs(sampleShare - volumeShare) <= 0.05;
  });

  console.log("\n  week 2: a novel error pattern - invoice amounts degrade to " + pct(DRIFTED_AMOUNT_ACCURACY) + " accuracy at UNCHANGED ~0.97 confidence");
  const week2 = buildCorpus("wk2", WEEK2_DRIFT);
  const week2Strata = stratifiedSample(week2.extractions, SAMPLE_RATE);

  const driftedErrors = week2.extractions.filter((ext) => ext.documentType === "invoice" && !fieldIsCorrect(ext, "amount", week2.truthById));
  const lowConfidenceSet = week2.extractions.filter((ext) => ext.overallConfidence < RAW_HIGH_CONFIDENCE);
  const driftedErrorsInLowSet = lowConfidenceSet.filter((ext) => ext.documentType === "invoice" && !fieldIsCorrect(ext, "amount", week2.truthById));

  const invoiceHighSample = week2Strata.find((s) => s.key === "invoice/high");
  const sampledInvoices = invoiceHighSample ? invoiceHighSample.sampled : [];
  const observedErrors = sampledInvoices.filter((ext) => !fieldIsCorrect(ext, "amount", week2.truthById)).length;
  const observedErrorRate = sampledInvoices.length > 0 ? observedErrors / sampledInvoices.length : 0;
  const expectedErrorRate =
    sampledInvoices.length > 0
      ? sampledInvoices.reduce((sum, ext) => sum + (1 - calibratedAccuracy(calibration, "invoice", "amount", ext.fields.amount.confidence)), 0) / sampledInvoices.length
      : 0;
  const driftAlarm = observedErrorRate >= DRIFT_ALARM_FACTOR * expectedErrorRate && observedErrorRate - expectedErrorRate >= 0.1;

  console.log(`  drifted invoice-amount errors in the corpus: ${driftedErrors.length}`);
  console.log(`  low-confidence-only review policy would inspect ${driftedErrorsInLowSet.length} of them - the drift is INVISIBLE there`);
  console.log(
    `  stratified invoice/high sample (${sampledInvoices.length} items): observed amount error rate ${pct(observedErrorRate)} vs ` +
      `${pct(expectedErrorRate)} expected from week-1 calibration -> ${driftAlarm ? "DRIFT ALARM" : "no alarm"} (${(observedErrorRate / Math.max(expectedErrorRate, 0.001)).toFixed(1)}x)`,
  );

  // --- Step 5 ---------------------------------------------------------------
  console.log("\n=== Step 5: review router - highest CALIBRATED uncertainty first, reordered on arrival ===");
  const initialArrivals = [
    demoExtraction("demo-invoice-1", "invoice", { vendorName: 0.97, date: 0.96, amount: 0.98 }, 0),
    demoExtraction("demo-scan-1", "scannedPdf", { vendorName: 0.8, date: 0.74, amount: 0.7 }, 1),
    demoExtraction("demo-receipt-1", "receipt", { vendorName: 0.78, date: 0.62, amount: 0.74 }, 2),
    demoExtraction("demo-invoice-2", "invoice", { vendorName: 0.99, date: 0.93, amount: 0.96 }, 3),
    demoExtraction("demo-scan-2", "scannedPdf", { vendorName: 0.84, date: 0.77, amount: 0.72 }, 4),
  ];
  // Raw confidence says demo-intl-1 (0.760 overall) is SAFER than demo-receipt-1
  // (0.713) - calibration says the opposite, because international vendor names
  // at reported ~0.78 are far less reliable than a handwritten receipt's date.
  const lateArrivals = [
    demoExtraction("demo-intl-1", "international", { vendorName: 0.78, date: 0.76, amount: 0.74 }, 5),
    demoExtraction("demo-invoice-3", "invoice", { vendorName: 0.98, date: 0.94, amount: 0.97 }, 6),
  ];
  const demoItems = [...initialArrivals, ...lateArrivals];

  const queue = new ReviewQueue(calibration);
  interface ServedRecord {
    item: QueueItem;
    wasMinimum: boolean;
  }
  const served: ServedRecord[] = [];
  const popAndRecord = (): void => {
    const before = queue.snapshot();
    const item = queue.next();
    if (!item) return;
    served.push({ item, wasMinimum: before.every((other) => item.calibratedConfidence <= other.calibratedConfidence + 1e-9) });
  };

  for (const ext of initialArrivals) queue.add(ext);
  popAndRecord();
  popAndRecord();
  console.log(`  2 items served; ${queue.size} still queued - now 2 new extractions arrive mid-shift`);
  for (const ext of lateArrivals) queue.add(ext);
  while (queue.size > 0) popAndRecord();

  console.log(`  ${"served".padEnd(8)}${"id".padEnd(18)}${"type".padEnd(15)}${"arrival".padStart(8)}${"raw".padStart(8)}${"calibrated".padStart(12)}  weakest field`);
  served.forEach((record, i) => {
    const ext = record.item.extraction;
    console.log(
      `  ${`#${i + 1}`.padEnd(8)}${ext.id.padEnd(18)}${ext.documentType.padEnd(15)}${`#${ext.arrivalSeq}`.padStart(8)}` +
        `${ext.overallConfidence.toFixed(3).padStart(8)}${record.item.calibratedConfidence.toFixed(3).padStart(12)}  ${record.item.weakestField}`,
    );
  });

  const servedArrivals = served.map((record) => record.item.extraction.arrivalSeq);
  const servedChronologically = servedArrivals.every((seq, i) => i === 0 || servedArrivals[i - 1] <= seq);
  const everyPopWasMinimum = served.every((record) => record.wasMinimum);
  const thirdServed = served.length > 2 ? served[2].item.extraction.id : "(none)";

  const ranked = demoItems.map((ext) => ({ ext, raw: ext.overallConfidence, calibrated: weakestCalibratedField(calibration, ext).accuracy }));
  let inversion: { safer: (typeof ranked)[number]; riskier: (typeof ranked)[number] } | null = null;
  for (const a of ranked) {
    for (const b of ranked) {
      if (a.raw > b.raw && a.calibrated < b.calibrated) inversion = { safer: b, riskier: a };
    }
  }
  if (inversion) {
    console.log(
      `\n  raw-vs-calibrated inversion: ${inversion.riskier.ext.id} reports raw ${inversion.riskier.raw.toFixed(3)} > ` +
        `${inversion.safer.ext.id}'s ${inversion.safer.raw.toFixed(3)}, but calibrated ${inversion.riskier.calibrated.toFixed(3)} < ` +
        `${inversion.safer.calibrated.toFixed(3)} - a raw-confidence queue would review them in the WRONG order.`,
    );
  }

  // --- Acceptance criteria ----------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  check(
    `confidence distributions differ per document type (mean overall ${meanInvoice.toFixed(2)} > ${meanScanned.toFixed(2)} > ${meanReceipt.toFixed(2)} > ${meanInternational.toFixed(2)}) and every field confidence is in [0,1]`,
    confidencesInRange && meanInvoice - meanScanned >= 0.03 && meanScanned - meanReceipt >= 0.03 && meanReceipt - meanInternational >= 0.03,
  );
  check(
    "standard invoices >= 95% accurate on every field",
    FIELDS.every((field) => accuracyOf(accuracy.invoice[field]) >= 0.95),
  );
  check(
    `aggregate looks excellent (${pct(aggregate)} >= 88%) while the worst segment (${worst.type}/${worst.field} at ${pct(worst.accuracy)}) is in the 25-60% disaster zone`,
    aggregate >= 0.88 && worst.accuracy <= 0.6 && worst.accuracy >= 0.25,
  );
  check(
    `the aggregate masks a gap of ${((aggregate - worst.accuracy) * 100).toFixed(1)} points to the worst segment (>= 25 required)`,
    aggregate - worst.accuracy >= 0.25,
  );
  check(
    `calibration reveals one reported band mapping to accuracies >= 10 points apart across segments (measured ${divergence ? (divergence.spread * 100).toFixed(1) : "0"} points)`,
    divergence !== null && divergence.spread >= 0.1,
  );
  const intlVendorBands = reliableBands(calibration, "international", "vendorName");
  const invoiceDateBands = reliableBands(calibration, "invoice", "date");
  const intlVendorTop = intlVendorBands[intlVendorBands.length - 1];
  const invoiceDateTop = invoiceDateBands[invoiceDateBands.length - 1];
  check(
    "miscalibration has a direction: international/vendorName is overconfident (accuracy >= 10 points below its band midpoint) while invoice/date is not",
    intlVendorBands.length > 0 &&
      invoiceDateBands.length > 0 &&
      intlVendorTop.band + BAND_SIZE / 2 - intlVendorTop.accuracy >= 0.1 &&
      invoiceDateTop.accuracy >= invoiceDateTop.band + BAND_SIZE / 2 - 0.02,
  );
  check(
    "stratified sample draws from EVERY stratum including high-confidence, and every document type is represented",
    week1Strata.every((s) => s.sampled.length >= 1) &&
      week1Strata.some((s) => s.key.endsWith("/high") && s.sampled.length > 0) &&
      DOC_TYPES.every((type) => week1Strata.some((s) => s.key.startsWith(`${type}/`) && s.sampled.length > 0)),
  );
  check("per-type sample share tracks volume share within 5 points (proportional sampling)", typeShareOk);
  check(
    `week-2 drift caught ONLY by the high-confidence stratum: observed ${pct(observedErrorRate)} vs expected ${pct(expectedErrorRate)} (alarm), while low-confidence-only review inspected ${driftedErrorsInLowSet.length}/${driftedErrors.length} drifted errors`,
    driftAlarm && driftedErrorsInLowSet.length === 0 && driftedErrors.length > 100,
  );
  check("review queue: every served item had the lowest calibrated confidence in the queue at that moment", everyPopWasMinimum);
  check(
    `review queue never served chronologically (served arrival order: ${servedArrivals.map((seq) => `#${seq}`).join(", ")})`,
    !servedChronologically,
  );
  check(
    `dynamic reordering: the late-arriving international item was served next (#3 served = ${thirdServed}), ahead of earlier arrivals still queued`,
    thirdServed === "demo-intl-1",
  );
  check(
    "prioritising by RAW confidence would order at least one pair of items the opposite way to calibrated confidence",
    inversion !== null,
  );

  console.log("\n  Note: every number above is deterministic (seeded PRNG) - rerunning prints the");
  console.log("  identical corpus, curves and queue order. Change SEED to resample; the checks");
  console.log("  assert distribution-level properties, so they hold for any reasonable seed.");
}

main();
