// Host CPU usage for /api/stats.
//
// os.cpus() reports cumulative times since boot, so (busy / total) of a
// single sample is the average since boot — on a long-running host it barely
// moves. The meter instead measures the busy share between two samples: the
// previous request's sample and this one (or, on the very first read, a
// short priming window).

export type CpuTimes = { idle: number; total: number };

type CpuInfo = { times: Record<string, number> };

export function sampleCpuTimes(cpus: readonly CpuInfo[]): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle || 0;
  }
  return { idle, total };
}

/** Busy percentage between two samples, or null for an empty window. */
export function cpuUsagePercentBetween(
  previous: CpuTimes,
  next: CpuTimes,
): number | null {
  const total = next.total - previous.total;
  if (!(total > 0)) return null;
  const idle = next.idle - previous.idle;
  const percent = ((total - idle) / total) * 100;
  return Math.min(100, Math.max(0, percent));
}

export function createCpuUsageMeter({
  readCpus,
  now = Date.now,
  wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
  primeWindowMs = 200,
  minWindowMs = 1000,
}: {
  readCpus: () => readonly CpuInfo[];
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  primeWindowMs?: number;
  minWindowMs?: number;
}) {
  let previous: { times: CpuTimes; at: number } | null = null;
  let lastPercent = 0;
  let inflight: Promise<number> | null = null;

  async function measure(): Promise<number> {
    if (!previous) {
      previous = { times: sampleCpuTimes(readCpus()), at: now() };
      await wait(primeWindowMs);
    } else if (now() - previous.at < minWindowMs) {
      // Another tab asked a moment ago; a tiny window is mostly noise.
      return lastPercent;
    }
    const next = { times: sampleCpuTimes(readCpus()), at: now() };
    const percent = cpuUsagePercentBetween(previous.times, next.times);
    previous = next;
    if (percent !== null) lastPercent = Math.round(percent);
    return lastPercent;
  }

  /** Rounded busy percentage since the previous read. */
  function read(): Promise<number> {
    inflight ??= measure().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return { read };
}
