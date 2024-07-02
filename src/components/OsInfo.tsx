import React, { useState, useEffect } from 'react'
import { invoke } from "@tauri-apps/api/tauri";


const OsInfo = () => {
    const [osInfo, setOsInfo] = useState<String>("")

    useEffect(() => {
        invoke<string>("get_os_info")
          .then(setOsInfo)
          .catch(console.error);
      }, []);

  return (
    <span className='os-info'> OS: <span className='text-blue bold-600'>{osInfo}</span></span>
  )
}

export default OsInfo