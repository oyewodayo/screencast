// export interface WindowInfo {
//     title: string;
//     image: number[]; // This will be a Uint8Array when received from Tauri
//   }
 export type WindowInfo = {
    title: string;
    image_path: string;
  };