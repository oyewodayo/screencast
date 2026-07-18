import { BsDot } from 'react-icons/bs'

interface DropdownProps {
    onCallback:(value:any)=>void
}
const Dropdown = ({onCallback}:DropdownProps) => {
  return (
    <div className="origin-bottom-right absolute bottom-full w-[120px] rounded-md shadow-lg bg-white dark:bg-neutral-800 text-gray-700 dark:text-neutral-200 ring-1 ring-black dark:ring-white/10 ring-opacity-5">
        <div className="py-1  w-[100%]">
            <button
            className="flex place-items-center w-[100%] px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 text-left"
            onClick={()=>onCallback(5)}
            >
            <BsDot className='text-green-500 -my-1 text-3xl'/> 5 sec
            </button>
            <button
            className="flex place-items-center block px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 w-full text-left"
            onClick={()=>onCallback(10)}
            >
            <BsDot className='text-green-500 -my-1 text-3xl'/> 10 sec
            </button>
            <button
            className="flex place-items-centerblock px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 w-full text-left"

            onClick={()=>onCallback(15)}
            >
            <BsDot className='text-green-500 -my-1 text-3xl'/> 15 sec
            </button>
        </div>
    </div>
  )
}

export default Dropdown