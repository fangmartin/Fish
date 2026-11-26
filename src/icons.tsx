import type { SVGProps } from 'react'

const paths = {
  fish: 'M3 12c3.2-5.5 9.3-6.8 14-2.4L21 7v10l-4-2.6C12.3 18.8 6.2 17.5 3 12Z M8 11.6h.01',
  shuffle: 'M3 6h3c5 0 6 12 11 12h4m-4-4 4 4-4 4M3 18h3c1.8 0 3.2-1.6 4.5-4M14 9c.9-1.7 2-3 3.5-3H21m-4-4 4 4-4 4',
  search: 'M21 21l-4.3-4.3m1.3-5.7a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  locate: 'M12 2v4m0 12v4M2 12h4m12 0h4m-4 0a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-4 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  sound: 'M3 9v6h4l5 4V5L7 9H3Zm13 0a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12',
  mute: 'M3 9v6h4l5 4V5L7 9H3Zm13 0 5 6m0-6-5 6',
  expand: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  keeper: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  pen: 'm4 15-1 6 6-1L20 9a2.1 2.1 0 0 0 0-3l-2-2a2.1 2.1 0 0 0-3 0L4 15Zm9-9 5 5',
  jar: 'M8 3h8v4H8zM8 7l-3 4v7a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-7l-3-4M5 12h14m-9 4h.01m4 1h.01',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M19 12H5m6-6-6 6 6 6',
  info: 'M12 11v5m0-8h.01m10 4a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  undo: 'M4 11h10a5 5 0 0 1 0 10M4 11l5-5m-5 5 5 5',
  redo: 'M20 11H10a5 5 0 0 0 0 10m10-10-5-5m5 5-5 5',
  clear: 'M5 7h14m-12 0 1 13h8l1-13M9 7V4h6v3m-4 4v5m2-5v5',
  image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm-1 12 5-5 4 4 3-3 4 4M15 8h.01',
  template: 'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z',
  eraser: 'm4 13 9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-9 9H8l-4-4a2 2 0 0 1 0-3Zm4-4 7 7m-4 4h10',
  fill: 'm3 12 7-7 8 8-7 7-8-8Zm3-9 6 6m-9 3h14m3 2s-2 2.5-2 4a2 2 0 0 0 4 0c0-1.5-2-4-2-4Z',
  picker: 'M16 3 9 10l5 5 7-7-5-5Zm-6 9-6 6-1 3 3-1 6-6m1-8 5 5',
  line: 'M5 19 19 5M5 19h.01M19 5h.01',
  mirrorX: 'M12 2v20M8 6l-5 11h5V6Zm8 0 5 11h-5V6Z',
  mirrorY: 'M2 12h20M6 8l11-5v5H6Zm0 8 11 5v-5H6Z',
  wave: 'M2 12c4-10 6-10 10 0s6 10 10 0',
  copy: 'M8 8h12v12H8zM16 4H4v12',
  flag: 'M5 21V4c5-4 8 4 14 0v10c-6 4-9-4-14 0',
  archive: 'M4 4h16v5H4zM6 9v11h12V9m-8 4h4',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
} as const

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d={paths[name]} />
  </svg>
}
