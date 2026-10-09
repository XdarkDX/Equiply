/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./public/**/*.{html,js}'],
    theme: {
        extend: {
            colors: { ozean: { leicht: '#e0f2fe', normal: '#0284c7', tief: '#0369a1' } },
        },
    },
};
