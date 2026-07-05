// Build config for tailwind.css (replaces the old cdn.tailwindcss.com runtime compiler).
// Rebuild after any HTML/class change:
//   npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.src.css -o tailwind.css --minify
module.exports = {
  content: ['./index.html'],
  theme: {
    extend: {
      colors: {
        brand: { blue: '#171C8F', orange: '#E35205', white: '#FFFFFF', gray: '#f8fafc' }
      },
      fontFamily: {
        sans: ['"Noto Sans Thai"', 'sans-serif'],
      }
    }
  }
};
