import type { DoseClass } from "@/lib/types";

export type EventStatus = "taken" | "missed" | "skipped" | "late";

export interface DemoScheduledDose {
  dose_id: string;
  hours_from_now: number;
  dose_class: DoseClass;
  dose_strength_mg: number;
  label: string;
}

export interface DemoHistoryEvent {
  dose_id: string;
  hours_from_now: number; // negative for past
  status: EventStatus;
  taken_offset_min?: number; // minutes after scheduled when taken (only for taken/late)
  dose_class: DoseClass;
  dose_strength_mg: number;
}

export interface Persona {
  id: string;
  user_id: string;
  name: string;
  age: number;
  blurb: string;
  conditions: string[];
  schedule: DemoScheduledDose[];
  history: DemoHistoryEvent[];
}

// Build a 14-day history with a given adherence rate, returning DoseEvent rows
// scheduled at consistent times per day for a small dose set.
function build_history(
  doses: { dose_id: string; hour: number; dose_class: DoseClass; mg: number }[],
  days: number,
  adherence: number,
  seed: number,
): DemoHistoryEvent[] {
  // Deterministic PRNG so repeated demo clicks are stable.
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const out: DemoHistoryEvent[] = [];
  for (let d = days; d >= 1; d--) {
    for (const dose of doses) {
      // scheduled hours from now: -(d * 24) + dose.hour
      const sched_hours = -(d * 24) + dose.hour;
      const r = rand();
      let status: EventStatus;
      let taken_offset: number | undefined;
      if (r < adherence) {
        status = "taken";
        taken_offset = Math.round(rand() * 25 - 5); // -5..+20 min
      } else if (r < adherence + (1 - adherence) * 0.55) {
        status = "missed";
      } else if (r < adherence + (1 - adherence) * 0.85) {
        status = "late";
        taken_offset = Math.round(60 + rand() * 240); // 1-5h late
      } else {
        status = "skipped";
      }
      out.push({
        dose_id: `${dose.dose_id}-d${d}`,
        hours_from_now: sched_hours,
        status,
        taken_offset_min: taken_offset,
        dose_class: dose.dose_class,
        dose_strength_mg: dose.mg,
      });
    }
  }
  return out;
}

export const PERSONAS: Persona[] = [
  {
    id: "stable",
    user_id: "demo-rivera-amelia",
    name: "Amelia Rivera",
    age: 62,
    blurb:
      "Long-term hypertension control. Two daily cardio doses, taken consistently for six months.",
    conditions: ["Hypertension", "Hyperlipidemia"],
    schedule: [
      {
        dose_id: "amlodipine-am",
        hours_from_now: 0.5,
        dose_class: "cardio",
        dose_strength_mg: 5,
        label: "Amlodipine 5 mg",
      },
      {
        dose_id: "atorvastatin-pm",
        hours_from_now: 11,
        dose_class: "cardio",
        dose_strength_mg: 20,
        label: "Atorvastatin 20 mg",
      },
      {
        dose_id: "amlodipine-am-d1",
        hours_from_now: 24.5,
        dose_class: "cardio",
        dose_strength_mg: 5,
        label: "Amlodipine 5 mg (tomorrow)",
      },
    ],
    history: build_history(
      [
        { dose_id: "amlodipine-am", hour: 8, dose_class: "cardio", mg: 5 },
        { dose_id: "atorvastatin-pm", hour: 21, dose_class: "cardio", mg: 20 },
      ],
      14,
      0.94,
      11,
    ),
  },
  {
    id: "slipping",
    user_id: "demo-okafor-daniel",
    name: "Daniel Okafor",
    age: 47,
    blurb:
      "Type 2 diabetes plus SSRI. Evening doses slipping over the last two weeks, often taken hours late.",
    conditions: ["Type 2 diabetes", "Major depressive disorder"],
    schedule: [
      {
        dose_id: "metformin-am",
        hours_from_now: 1,
        dose_class: "endocrine",
        dose_strength_mg: 500,
        label: "Metformin 500 mg",
      },
      {
        dose_id: "metformin-pm",
        hours_from_now: 13,
        dose_class: "endocrine",
        dose_strength_mg: 500,
        label: "Metformin 500 mg",
      },
      {
        dose_id: "sertraline-pm",
        hours_from_now: 14,
        dose_class: "psych",
        dose_strength_mg: 50,
        label: "Sertraline 50 mg",
      },
      {
        dose_id: "metformin-am-d1",
        hours_from_now: 25,
        dose_class: "endocrine",
        dose_strength_mg: 500,
        label: "Metformin 500 mg (tomorrow)",
      },
    ],
    history: build_history(
      [
        { dose_id: "metformin-am", hour: 8, dose_class: "endocrine", mg: 500 },
        { dose_id: "metformin-pm", hour: 20, dose_class: "endocrine", mg: 500 },
        { dose_id: "sertraline-pm", hour: 21, dose_class: "psych", mg: 50 },
      ],
      14,
      0.62,
      29,
    ),
  },
  {
    id: "newcomer",
    user_id: "demo-tanaka-mei",
    name: "Mei Tanaka",
    age: 29,
    blurb:
      "Newly prescribed antibiotic course plus thyroid. Five days of history, mixed early-course behaviour.",
    conditions: ["Post-op infection", "Hypothyroidism"],
    schedule: [
      {
        dose_id: "amox-am",
        hours_from_now: 0.25,
        dose_class: "antibiotic",
        dose_strength_mg: 500,
        label: "Amoxicillin 500 mg",
      },
      {
        dose_id: "amox-noon",
        hours_from_now: 8,
        dose_class: "antibiotic",
        dose_strength_mg: 500,
        label: "Amoxicillin 500 mg",
      },
      {
        dose_id: "amox-pm",
        hours_from_now: 16,
        dose_class: "antibiotic",
        dose_strength_mg: 500,
        label: "Amoxicillin 500 mg",
      },
      {
        dose_id: "levothyroxine-am-d1",
        hours_from_now: 24,
        dose_class: "endocrine",
        dose_strength_mg: 75,
        label: "Levothyroxine 75 mcg (tomorrow)",
      },
    ],
    history: build_history(
      [
        { dose_id: "amox-am", hour: 7, dose_class: "antibiotic", mg: 500 },
        { dose_id: "amox-noon", hour: 15, dose_class: "antibiotic", mg: 500 },
        { dose_id: "amox-pm", hour: 23, dose_class: "antibiotic", mg: 500 },
        { dose_id: "levothyroxine-am", hour: 6, dose_class: "endocrine", mg: 75 },
      ],
      5,
      0.78,
      53,
    ),
  },
];
