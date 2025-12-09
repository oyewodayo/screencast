import { CgClose } from 'react-icons/cg'


interface AlertProps {
    labelBg?: string;
    title?: string;
    message?: string;
    buttonLabel?: string;
    onCallback?: () => void;
    onClose?: () => void;
  }

const Alert = ({ labelBg = "blue", title="", message="This is an alert",buttonLabel, onCallback=()=>{}, onClose }:AlertProps) => {

 

  return (
    <div className={`fixed top-10 z-[100] sm:top-auto md:max-w-[420px] max-h-screen w-full flex flex-row bg-white text-sm ring-1 ring-slate-100 shadow-md mx-2 my-3 px-3 py-2 rounded justify-between place-items-center`}>
        <div className='grid gap-1'>
            <div className='text-sm font-semibold'>{title}</div>
            <div className='text-xs opacity-90'> {message}</div>
        </div>
        <div className='flex place-items-center gap-3'>
            {buttonLabel && <button className={`shadow-md rounded px-3 py-1 focus:right-1 bg-${labelBg}-100 focus:ring-ring`}
            onClick={onCallback}
            >{buttonLabel}</button>}
            <CgClose className='cursor-pointer' 
            onClick={onClose} 
            />
        </div>
    </div>
  )
}

export default Alert