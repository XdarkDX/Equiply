/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./public/**/*.{html,js}'],
    theme: {
        extend: {
            // Vereinsfarbe: wird zur Laufzeit über CSS-Variablen gesetzt (siehe applyTheme in app.js)
            colors: { ozean: { leicht: 'rgb(var(--ozean-leicht) / <alpha-value>)', normal: 'rgb(var(--ozean-normal) / <alpha-value>)', tief: 'rgb(var(--ozean-tief) / <alpha-value>)' } },
        },
    },
};
