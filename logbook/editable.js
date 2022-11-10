function injectAnnotations() {
  const editables = document.querySelectorAll('td[contenteditable]');
  const annotations = JSON.parse(localStorage.getItem('annotations')) || [];
  editables.forEach((editable) => {
    const timestamp = editable.parentElement.dataset.time;
    const override = annotations.find((element) => element.time === timestamp);
    if (override) {
      editable.innerText = override.value;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  injectAnnotations();

  const editables = document.querySelectorAll('td[contenteditable]');
  editables.forEach((editable) => {
    editable.addEventListener('keyup', () => {
      const timestamp = editable.parentElement.dataset.time;
      const annotations = JSON.parse(localStorage.getItem('annotations')) || [];
      const annotation = {
        time: timestamp,
        value: editable.innerText,
      };
      const override = annotations.find((element) => element.time === timestamp);
      if (override) {
        const idx = annotations.indexOf(override);
        annotations[idx] = annotation;
      } else {
        annotations.push(annotation);
      }
      localStorage.setItem('annotations', JSON.stringify(annotations));
    });
  });
});
