import { useState } from 'react'
import { FaClosedCaptioning } from 'react-icons/fa'
import { MdOutlineOpacity } from 'react-icons/md'

// Define the props interface
interface PlaytimeSettingsProps {
  onAutoplayChange: () => void;
  isAutoplay: boolean;
  playbackSpeed: string;
  onPlaybackSpeedChange: (speed: string) => void;
}

const PlaytimeSettings: React.FC<PlaytimeSettingsProps> = ({
  onAutoplayChange,
  isAutoplay,
  playbackSpeed,
  onPlaybackSpeedChange
}) => {
  const [isSubtitle, setIsSubtitle] = useState<boolean>(false);
  const [opacity, setOpacity] = useState<number>(1.0);
  
  const handleOpacity = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const newOpacity = parseFloat(event.target.value);
    setOpacity(newOpacity);
    console.log("Opacity slider value:", newOpacity);
    // Apply opacity logic here if needed
  };

  const handlePlaybackSpeedChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const newSpeed = event.target.value;
    onPlaybackSpeedChange(newSpeed);
  };

  // Predefined playback speed options
  const playbackSpeeds = ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'];

  return (
    <div className="origin-bottom-right absolute bottom-full right-0 w-[220px] rounded-md shadow-lg bg-white text-gray-700 ring-1 ring-black ring-opacity-5 z-50">
      <div className="py-1 w-[100%]">
        
        {/* Autoplay Setting */}
        <button
          className="flex justify-between place-items-center w-[100%] px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left"
          onClick={onAutoplayChange}
        >
          <div className='flex gap-2 place-items-center'>
            Autoplay
          </div>
          <label className="switch">
            <input 
              type="checkbox" 
              checked={isAutoplay}
              onChange={onAutoplayChange}
              name="autoplay" 
            />
            <span className="slider round"></span>
          </label>
        </button>

        {/* Playback Speed Setting */}
        <div className="flex justify-between place-items-center w-[100%] px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">
          <div className='flex gap-2 place-items-center'>
            Playback Speed
          </div>
          <select 
            value={playbackSpeed.replace('x', '')} 
            onChange={handlePlaybackSpeedChange}
            className="bg-gray-100 border border-gray-300 text-gray-700 text-sm rounded focus:ring-blue-500 focus:border-blue-500 p-1"
          >
            {playbackSpeeds.map((speed) => (
              <option key={speed} value={speed}>
                {speed}x
              </option>
            ))}
          </select>
        </div>

        {/* Opacity Setting */}
        <div className="flex justify-between place-items-center w-[100%] px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">
          <div className='flex gap-2 place-items-center'>
            <MdOutlineOpacity className='-my-1 text-2xl'/> 
            Opacity 
          </div>
          <input 
            type="range" 
            min={0} 
            max={1} 
            step={0.1}
            value={opacity}
            onChange={handleOpacity}
            name="video-opacity" 
            className='w-20' 
          />
        </div>

        {/* Subtitles Setting */}
        <button
          className="flex justify-between place-items-center w-[100%] px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left"
          onClick={() => setIsSubtitle(!isSubtitle)}
        >
          <div className='flex gap-2 place-items-center'> 
            <FaClosedCaptioning className={`w-[100%] ${isSubtitle ? 'text-red-500' : ''} text-2xl`} />
            Subtitles 
          </div>
          <label className="switch">
            <input 
              type="checkbox" 
              checked={isSubtitle}
              onChange={() => setIsSubtitle(!isSubtitle)} 
              name="subtitle" 
            />
            <span className="slider round"></span>
          </label>
        </button>
       
      </div>
    </div>
  )
}

export default PlaytimeSettings