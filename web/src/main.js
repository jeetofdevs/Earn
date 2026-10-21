import "./style.css";

// Close the other FAQ answers when one opens.
const faq = document.querySelectorAll(".faq details");
faq.forEach((d) =>
  d.addEventListener("toggle", () => {
    if (d.open) faq.forEach((o) => o !== d && (o.open = false));
  }),
);
