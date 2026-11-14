import {
  defineConfig,
  presetUno,
  presetAttributify,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'

export default defineConfig({
  presets: [presetUno(), presetAttributify()],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme: {
    colors: {
      brand: {
        50: '#eef7ff',
        100: '#d9edff',
        200: '#bce0ff',
        300: '#8ecdff',
        400: '#59b0ff',
        500: '#3390fc',
        600: '#1d70f1',
        700: '#175ade',
        800: '#1949b4',
        900: '#1a408d',
      },
      candy: {
        50: '#fff1f7',
        100: '#ffe4ef',
        200: '#ffc9df',
        300: '#ff9dc6',
        400: '#ff61a4',
        500: '#ff3385',
        600: '#f01264',
        700: '#d1044f',
      },
      mint: {
        400: '#3ddc97',
        500: '#1fc47d',
      },
    },
  },
  shortcuts: {
    'btn-candy':
      'px-6 py-3 rounded-full bg-candy-500 text-white font-bold shadow-lg shadow-candy-500/30 hover:bg-candy-600 active:scale-95 transition',
    'card-soft': 'bg-white/90 rounded-3xl shadow-xl shadow-slate-900/5 p-5',
  },
})
