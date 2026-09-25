import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { constants, type StorageReminderSettings } from "@pragma-sh/constants";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  formatLocalDate,
  nextReminder,
  parseLocalDate,
  reminderIntervalDays,
} from "@/lib/storage-reminder";

const CUSTOM = "custom";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Local midnight `days` calendar days from today. */
function daysFromToday(days: number): Date {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
}

/** "Every week", "Every 30 days", … */
function intervalLabel(days: number): string {
  if (days === 1) return "Every day";
  if (days === 7) return "Every week";
  if (days % 7 === 0) return `Every ${days / 7} weeks`;
  return `Every ${days} days`;
}

/**
 * Global storage reminder: a start date picked on a calendar and an interval.
 * Stored under `storage.reminder` in the global `config.json`; the reminder
 * itself is raised by `useStorageReminder`.
 */
export function StorageReminderCard({
  settings,
  persist,
}: {
  settings: StorageReminderSettings;
  persist: (patch: StorageReminderSettings) => Promise<void>;
}) {
  const enabled = settings.enabled ?? false;
  const interval = reminderIntervalDays(settings);
  const presets = constants.storage.reminderIntervalPresets;
  const isPreset = presets.includes(interval);
  const [customMode, setCustomMode] = useState(!isPreset);
  const [customDraft, setCustomDraft] = useState(String(interval));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const start = parseLocalDate(settings.startDate);
  const next = nextReminder({ ...settings, enabled: true }, new Date());

  useEffect(() => setCustomDraft(String(interval)), [interval]);

  return (
    <SettingsCard
      title="Storage reminder"
      description="Get a nudge to review disk usage on a schedule. Reminders start on the date you pick and repeat at the interval."
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <label className="text-sm" htmlFor="storage-reminder-enabled">
            Remind me to review storage
          </label>
          <Switch
            checked={enabled}
            id="storage-reminder-enabled"
            onCheckedChange={(checked) =>
              void persist({
                enabled: checked,
                // A reminder needs a first date; default to one interval out
                // so switching it on does not remind straight away.
                startDate: settings.startDate ?? formatLocalDate(daysFromToday(interval)),
                intervalDays: interval,
              })
            }
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <span className="block text-sm">Repeat</span>
            <Select
              disabled={!enabled}
              value={customMode ? CUSTOM : String(interval)}
              onValueChange={(value) => {
                if (value === CUSTOM) {
                  setCustomMode(true);
                  return;
                }
                setCustomMode(false);
                void persist({ intervalDays: Number(value) });
              }}
            >
              <SelectTrigger aria-label="Reminder interval" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {intervalLabel(days)}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            {customMode ? (
              <label className="flex items-center gap-2 text-sm" htmlFor="storage-reminder-days">
                Every
                <Input
                  className="h-8 w-20"
                  disabled={!enabled}
                  id="storage-reminder-days"
                  inputMode="numeric"
                  min={1}
                  type="number"
                  value={customDraft}
                  onBlur={() => {
                    const days = Number.parseInt(customDraft, 10);
                    if (!Number.isInteger(days) || days < 1) {
                      setCustomDraft(String(interval));
                      return;
                    }
                    if (days !== interval) void persist({ intervalDays: days });
                  }}
                  onChange={(event) => setCustomDraft(event.target.value)}
                />
                days
              </label>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <span className="block text-sm">Starting on</span>
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  aria-label="First reminder date"
                  className="w-full justify-start font-normal"
                  disabled={!enabled}
                  variant="outline"
                >
                  <CalendarDays />
                  {start ? DATE_FORMAT.format(start) : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={start ?? undefined}
                  onSelect={(date) => {
                    if (!date) return;
                    setCalendarOpen(false);
                    void persist({ startDate: formatLocalDate(date) });
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {enabled && next ? `Next reminder: ${DATE_FORMAT.format(next)}.` : "Reminders are off."}
        </p>
      </div>
    </SettingsCard>
  );
}
