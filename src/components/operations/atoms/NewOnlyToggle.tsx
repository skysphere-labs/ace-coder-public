import { SegmentedControl } from '../molecules/SegmentedControl';

// Segmented "All / New" filter — a thin boolean adapter over the shared
// SegmentedControl molecule so this toggle inherits the canonical type/contrast
// standard (12px font-medium, inactive /70, sky active accent) for free.
export function NewOnlyToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SegmentedControl
      options={[
        { value: 'all', label: 'All' },
        { value: 'new', label: 'New' },
      ]}
      value={value ? 'new' : 'all'}
      onChange={(next) => onChange(next === 'new')}
      size="sm"
      ariaLabel="Show all items or only new ones"
    />
  );
}
