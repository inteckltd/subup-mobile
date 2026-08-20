import { Picker } from '@react-native-picker/picker';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { colors } from '../../../theme/tokens';

type IosWheelPickerProps = {
  mode: 'date' | 'time';
  value: Date;
  /** Date-mode only — earliest selectable calendar day (time-of-day is ignored). */
  minimumDate?: Date;
  onChange: (next: Date) => void;
};

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(new Date(2000, i, 1)),
);

const WHEEL_HEIGHT = 180;

const itemStyle = { fontSize: 20, fontWeight: '600' as const, color: colors.ink, height: WHEEL_HEIGHT };

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function range(start: number, endInclusive: number): number[] {
  return Array.from({ length: Math.max(0, endInclusive - start + 1) }, (_, i) => start + i);
}

/** Earliest selectable month for `year` — `minimumDate`'s month if `year` is its year, else January. */
function monthFloor(year: number, minimumDate?: Date): number {
  if (!minimumDate) return 0;
  return year === minimumDate.getFullYear() ? minimumDate.getMonth() : 0;
}

/** Earliest selectable day for `year`/`month` — `minimumDate`'s day only when both match it, else the 1st. */
function dayFloor(year: number, month: number, minimumDate?: Date): number {
  if (!minimumDate) return 1;
  return year === minimumDate.getFullYear() && month === minimumDate.getMonth() ? minimumDate.getDate() : 1;
}

/**
 * Three-column wheel picker built from independent `@react-native-picker/picker`
 * columns, replacing `@react-native-community/datetimepicker`'s iOS `spinner`
 * display. That native `UIDatePicker` forces a hardcoded ~280pt minimum width
 * onto its own layout node which *overrides* any JS `width`/`flex` style —
 * an open, unfixed upstream bug (react-native-datetimepicker/datetimepicker
 * issue #1014, PR #1036) that made the field impossible to stretch full
 * width no matter how the surrounding modal was sized. Each `Picker` column
 * here is a separate, simpler native wheel that genuinely respects `flex`,
 * so the row as a whole fills whatever width its container gives it.
 */
export function IosWheelPicker({ mode, value, minimumDate, onChange }: IosWheelPickerProps) {
  const [year, setYear] = useState(value.getFullYear());
  const [month, setMonth] = useState(value.getMonth());
  const [day, setDay] = useState(value.getDate());

  const initialHour24 = value.getHours();
  const [period, setPeriod] = useState<'AM' | 'PM'>(initialHour24 >= 12 ? 'PM' : 'AM');
  const [hour12, setHour12] = useState(initialHour24 % 12 || 12);
  const [minute, setMinute] = useState(value.getMinutes());

  const yearRangeStart = Math.min(minimumDate?.getFullYear() ?? value.getFullYear(), value.getFullYear());
  const years = useMemo(() => range(yearRangeStart, yearRangeStart + 5), [yearRangeStart]);
  const months = useMemo(() => range(monthFloor(year, minimumDate), 11), [year, minimumDate]);
  const days = useMemo(
    () => range(dayFloor(year, month, minimumDate), daysInMonth(year, month)),
    [year, month, minimumDate],
  );

  const emitDate = (nextYear: number, nextMonth: number, nextDay: number) => {
    const next = new Date(value);
    next.setFullYear(nextYear, nextMonth, nextDay);
    onChange(next);
  };

  const emitTime = (nextHour12: number, nextMinute: number, nextPeriod: 'AM' | 'PM') => {
    const next = new Date(value);
    const hour24 = (nextHour12 % 12) + (nextPeriod === 'PM' ? 12 : 0);
    next.setHours(hour24, nextMinute, 0, 0);
    onChange(next);
  };

  if (mode === 'time') {
    return (
      <View className="w-full flex-row" style={{ height: WHEEL_HEIGHT }}>
        <Picker
          style={{ flex: 1 }}
          itemStyle={itemStyle}
          selectedValue={hour12}
          onValueChange={(next: number) => {
            setHour12(next);
            emitTime(next, minute, period);
          }}
        >
          {range(1, 12).map((h) => (
            <Picker.Item key={h} label={String(h)} value={h} />
          ))}
        </Picker>
        <Picker
          style={{ flex: 1 }}
          itemStyle={itemStyle}
          selectedValue={minute}
          onValueChange={(next: number) => {
            setMinute(next);
            emitTime(hour12, next, period);
          }}
        >
          {range(0, 59).map((m) => (
            <Picker.Item key={m} label={m.toString().padStart(2, '0')} value={m} />
          ))}
        </Picker>
        <Picker
          style={{ flex: 0.8 }}
          itemStyle={itemStyle}
          selectedValue={period}
          onValueChange={(next: 'AM' | 'PM') => {
            setPeriod(next);
            emitTime(hour12, minute, next);
          }}
        >
          <Picker.Item label="AM" value="AM" />
          <Picker.Item label="PM" value="PM" />
        </Picker>
      </View>
    );
  }

  return (
    <View className="w-full flex-row" style={{ height: WHEEL_HEIGHT }}>
      <Picker
        style={{ flex: 0.8 }}
        itemStyle={itemStyle}
        selectedValue={day}
        onValueChange={(nextDay: number) => {
          setDay(nextDay);
          emitDate(year, month, nextDay);
        }}
      >
        {days.map((d) => (
          <Picker.Item key={d} label={String(d)} value={d} />
        ))}
      </Picker>
      <Picker
        style={{ flex: 1.4 }}
        itemStyle={itemStyle}
        selectedValue={month}
        onValueChange={(nextMonth: number) => {
          const nextDay = Math.max(day, dayFloor(year, nextMonth, minimumDate));
          const clampedDay = Math.min(nextDay, daysInMonth(year, nextMonth));
          setMonth(nextMonth);
          setDay(clampedDay);
          emitDate(year, nextMonth, clampedDay);
        }}
      >
        {months.map((m) => (
          <Picker.Item key={m} label={MONTH_NAMES[m]} value={m} />
        ))}
      </Picker>
      <Picker
        style={{ flex: 1 }}
        itemStyle={itemStyle}
        selectedValue={year}
        onValueChange={(nextYear: number) => {
          const nextMonth = Math.max(month, monthFloor(nextYear, minimumDate));
          const nextDayFloor = dayFloor(nextYear, nextMonth, minimumDate);
          const nextDay = Math.min(Math.max(day, nextDayFloor), daysInMonth(nextYear, nextMonth));
          setYear(nextYear);
          setMonth(nextMonth);
          setDay(nextDay);
          emitDate(nextYear, nextMonth, nextDay);
        }}
      >
        {years.map((y) => (
          <Picker.Item key={y} label={String(y)} value={y} />
        ))}
      </Picker>
    </View>
  );
}
