import { IoCheckmark } from 'react-icons/io5'

// The skip-amount picker opened by double-clicking either skip button. Styled like the Settings
// flyout (.settings-menu in player.css) - same surface, row height, hover and red check.
const SKIP_OPTIONS = [5, 10, 15, 30, 60]

interface DropdownProps {
    value: number
    onCallback: (value: number) => void
}

const Dropdown = ({ value, onCallback }: DropdownProps) => {
  return (
    <div className="skip-menu absolute bottom-full left-1/2 -translate-x-1/2 mb-3 rounded-lg shadow-lg bg-white dark:bg-neutral-800 text-gray-800 dark:text-neutral-100 ring-1 ring-black/5 dark:ring-white/10 z-50">
        <div className="skip-menu-header">Skip by</div>
        {SKIP_OPTIONS.map((seconds) => (
            <button
            key={seconds}
            className="skip-menu-item"
            onClick={() => onCallback(seconds)}
            aria-pressed={seconds === value}
            >
            <span>{seconds < 60 ? `${seconds} seconds` : '1 minute'}</span>
            {seconds === value && <IoCheckmark className="settings-check" />}
            </button>
        ))}
    </div>
  )
}

export default Dropdown
