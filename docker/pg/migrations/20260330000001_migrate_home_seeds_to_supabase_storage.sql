-- Migrate home seed images from external CDNs to Supabase Storage.
-- Replaces Lovart/Shakker/Google URLs with self-hosted assets.

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e1-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e1-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e1-3.webp'
    ]::text[]
  where category_key = 'design' and sort_order = 0;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e2-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e2-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e2-3.webp'
    ]::text[]
  where category_key = 'design' and sort_order = 1;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e3-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e3-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e3-3.webp'
    ]::text[]
  where category_key = 'design' and sort_order = 2;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e4-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e4-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e4-3.webp'
    ]::text[]
  where category_key = 'design' and sort_order = 3;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e5-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e5-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e5-3.webp'
    ]::text[]
  where category_key = 'design' and sort_order = 4;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e6-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e6-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e6-3.webp'
    ]::text[]
  where category_key = 'design' and sort_order = 5;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e1-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e1-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e1-3.webp'
    ]::text[]
  where category_key = 'branding' and sort_order = 0;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e2-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e2-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e2-3.webp'
    ]::text[]
  where category_key = 'branding' and sort_order = 1;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e3-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e3-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e3-3.webp'
    ]::text[]
  where category_key = 'branding' and sort_order = 2;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e4-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e4-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e4-3.webp'
    ]::text[]
  where category_key = 'branding' and sort_order = 3;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e5-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e5-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e5-3.webp'
    ]::text[]
  where category_key = 'branding' and sort_order = 4;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e6-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e6-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/branding/e6-3.webp'
    ]::text[]
  where category_key = 'branding' and sort_order = 5;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e1-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e1-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e1-3.webp'
    ]::text[]
  where category_key = 'illustration' and sort_order = 0;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e2-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e2-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e2-3.webp'
    ]::text[]
  where category_key = 'illustration' and sort_order = 1;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e3-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e3-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e3-3.webp'
    ]::text[]
  where category_key = 'illustration' and sort_order = 2;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e4-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e4-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e4-3.webp'
    ]::text[]
  where category_key = 'illustration' and sort_order = 3;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e5-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e5-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e5-3.webp'
    ]::text[]
  where category_key = 'illustration' and sort_order = 4;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e6-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e6-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/illustration/e6-3.webp'
    ]::text[]
  where category_key = 'illustration' and sort_order = 5;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e1-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e1-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e1-3.webp'
    ]::text[]
  where category_key = 'e-commerce' and sort_order = 0;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e2-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e2-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e2-3.webp'
    ]::text[]
  where category_key = 'e-commerce' and sort_order = 1;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e3-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e3-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e3-3.webp'
    ]::text[]
  where category_key = 'e-commerce' and sort_order = 2;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e4-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e4-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e4-3.webp'
    ]::text[]
  where category_key = 'e-commerce' and sort_order = 3;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e5-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e5-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e5-3.webp'
    ]::text[]
  where category_key = 'e-commerce' and sort_order = 4;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e6-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e6-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e6-3.webp'
    ]::text[]
  where category_key = 'e-commerce' and sort_order = 5;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e3-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e3-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/design/e3-3.webp'
    ]::text[]
  where category_key = 'video' and sort_order = 0;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e6-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e6-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/e-commerce/e6-3.webp'
    ]::text[]
  where category_key = 'video' and sort_order = 1;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e3-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e3-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e3-3.webp'
    ]::text[]
  where category_key = 'video' and sort_order = 2;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e4-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e4-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e4-3.webp'
    ]::text[]
  where category_key = 'video' and sort_order = 3;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e5-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e5-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e5-3.webp'
    ]::text[]
  where category_key = 'video' and sort_order = 4;

update public.home_example_examples
  set image_urls = array[
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e6-1.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e6-2.webp',
      'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/examples/video/e6-3.webp'
    ]::text[]
  where category_key = 'video' and sort_order = 5;

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/branding-design/cover.webp',
      author_name = 'Studio Arken',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/branding-design.svg',
      case_url = ''
  where id = 'ji5ey5l';

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/poster-and-ads/cover.webp',
      author_name = 'Retro Workshop',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/poster-and-ads.svg',
      case_url = ''
  where id = 'n9d21de';

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/illustration/cover.webp',
      author_name = 'Mochi Art',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/illustration.svg',
      case_url = ''
  where id = 'bjde0nh';

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/ui-design/cover.webp',
      author_name = 'Pixel Forge',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/ui-design.svg',
      case_url = ''
  where id = 'tl8zzk0';

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/character-design/cover.webp',
      author_name = 'Dark Carnival',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/character-design.svg',
      case_url = ''
  where id = 'fbn3mss';

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/storyboard-video/cover.webp',
      author_name = 'Frame Studio',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/storyboard-video.svg',
      case_url = ''
  where id = 'ikqo02k';

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/product-design/cover.webp',
      author_name = 'Future Lab',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/product-design.svg',
      case_url = ''
  where id = 'a4ncmvb';

update public.home_discovery_cases
  set cover_image_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/architecture-design/cover.webp',
      author_name = 'Arc Design',
      author_avatar_url = 'https://jmcrxgenontlkxktpihl.supabase.co/storage/v1/object/public/project-assets/home-seeds/discovery/avatars/architecture-design.svg',
      case_url = ''
  where id = 'ng716s0';

