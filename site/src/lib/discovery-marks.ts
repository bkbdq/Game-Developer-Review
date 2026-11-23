export const defaultDiscoveryMark = {
  id: 'mint-pad', name: '薄荷十字键', image: 'images/gc/mint-gamepad-168.webp',
  width: 168, height: 98,
  sources: [
    { image: 'images/gc/mint-gamepad-336.webp', width: 336 },
    { image: 'images/gc/mint-gamepad-504.webp', width: 504 },
  ],
} as const;

export const navigationMark = {
  id: 'octagon-token', name: '八角代币', image: 'images/gc/octagon-token.png',
} as const;

export const discoveryMarks = [
  defaultDiscoveryMark,
  { id: 'red-pad', name: '红白方柄', image: 'images/gc/red-pad.png' },
  { id: 'twin-pad', name: '紫晶双摇杆', image: 'images/gc/twin-pad.png' },
  { id: 'arcade-coin', name: '街机金币', image: 'images/gc/arcade-coin.png' },
  navigationMark,
  { id: 'coin-stack', name: '双层金币', image: 'images/gc/coin-stack.png' },
] as const;

export type DiscoveryMark = (typeof discoveryMarks)[number];
