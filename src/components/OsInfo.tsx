import { useState, useEffect } from 'react'
import { invoke } from "@tauri-apps/api/core";


const OsInfo = () => {
    const [osInfo, setOsInfo] = useState<String>("")

    useEffect(() => {
        invoke<string>("get_os_info")
          .then(setOsInfo)
          .catch(console.error);
      }, []);

  return (
    <span className=''> OS: <span className='text-blue-500'>{osInfo}</span></span>
  )
}

export default OsInfo