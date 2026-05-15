import type { TunableSubject, Adapter } from "./interfaces.js";
import type { TunerConfig } from "./config.js";

export class Registry {
  private subjects = new Map<string, TunableSubject>();
  private adapters = new Map<string, Adapter>();

  registerSubject(subject: TunableSubject): void {
    this.subjects.set(subject.name, subject);
  }

  registerAdapter(name: string, adapter: Adapter): void {
    this.adapters.set(name, adapter);
  }

  getSubject(name: string): TunableSubject | undefined {
    return this.subjects.get(name);
  }

  getAdapter(name: string): Adapter | undefined {
    return this.adapters.get(name);
  }

  allSubjects(): TunableSubject[] {
    return [...this.subjects.values()];
  }

  enabledSubjects(config: Pick<TunerConfig, "subjects">): TunableSubject[] {
    return [...this.subjects.values()].filter((s) => config.subjects?.[s.name]?.enabled !== false);
  }
}
