import "./style.css";

// Close the other FAQ answers when one opens.
const faq = document.querySelectorAll(".faq details");
faq.forEach((d) =>
  d.addEventListener("toggle", () => {
    if (d.open) faq.forEach((o) => o !== d && (o.open = false));
  }),
);

// Copy the contract address.
const caBtn = document.getElementById("ca-copy");
caBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("ca").textContent.trim());
    caBtn.textContent = "Copied ✓";
  } catch {
    caBtn.textContent = "Copy failed";
  }
  setTimeout(() => (caBtn.textContent = "Copy"), 1500);
});
