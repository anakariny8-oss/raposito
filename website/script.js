const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#primary-nav");

if (menuButton && navigation) {
  menuButton.addEventListener("click", () => {
    const isOpen = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!isOpen));
    navigation.classList.toggle("is-open", !isOpen);
    const label = menuButton.querySelector(".sr-only");
    if (label) label.textContent = isOpen ? "Abrir navegação" : "Fechar navegação";
  });

  navigation.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menuButton.setAttribute("aria-expanded", "false");
      navigation.classList.remove("is-open");
      const label = menuButton.querySelector(".sr-only");
      if (label) label.textContent = "Abrir navegação";
    });
  });
}

const liveStatus = document.querySelector(".copy-status");
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy") || "";
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = document.createElement("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        document.execCommand("copy");
        field.remove();
      }
      button.textContent = "Copiado";
      if (liveStatus) liveStatus.textContent = `Comando copiado: ${text}`;
      window.setTimeout(() => { button.textContent = "Copiar"; }, 1800);
    } catch (_) {
      if (liveStatus) liveStatus.textContent = `Selecione e copie o comando: ${text}`;
    }
  });
});

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());
